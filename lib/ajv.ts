export {
  Format,
  FormatDefinition,
  AsyncFormatDefinition,
  KeywordDefinition,
  Vocabulary,
} from "./types"
export interface Plugin<Opts> {
  (ajv: Ajv, options?: Opts): Ajv
  [prop: string]: any
}

import KeywordCxt from "./compile/context"
export {KeywordCxt}

import type {
  Schema,
  SchemaObject,
  SyncSchemaObject,
  AsyncSchemaObject,
  Vocabulary,
  KeywordDefinition,
  Options,
  InstanceOptions,
  ValidateFunction,
  ValidateGuard,
  SyncValidateFunction,
  AsyncValidateFunction,
  CacheInterface,
  Logger,
  ErrorObject,
  Format,
  AddedFormat,
} from "./types"
import type {JSONSchemaType} from "./types/json-schema"
import Cache from "./cache"
import {ValidationError, MissingRefError} from "./compile/error_classes"
import {getRules, ValidationRules, Rule, RuleGroup} from "./compile/rules"
import {checkType} from "./compile/validate/dataType"
import {SchemaEnv, compileSchema, resolveSchema} from "./compile"
import {ValueScope} from "./compile/codegen"
import {normalizeId, getSchemaRefs} from "./compile/resolve"
import coreVocabulary from "./vocabularies/core"
import validationVocabulary from "./vocabularies/validation"
import applicatorVocabulary from "./vocabularies/applicator"
import formatVocabulary from "./vocabularies/format"
import {metadataVocabulary, contentVocabulary} from "./vocabularies/metadata"
import stableStringify from "fast-json-stable-stringify"
import {eachItem} from "./compile/util"
import $dataRefSchema from "./refs/data.json"
import draft7MetaSchema from "./refs/json-schema-draft-07.json"

const META_SCHEMA_ID = "http://json-schema.org/draft-07/schema"

const META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"]
const META_SUPPORT_DATA = ["/properties"]
const EXT_SCOPE_NAMES = new Set([
  "validate",
  "wrapper",
  "root",
  "schema",
  "keyword",
  "pattern",
  "formats",
  "validate$data",
  "func",
  "Error",
])

const optsDefaults = {
  strict: true,
  code: {},
  loopRequired: Infinity,
  loopEnum: Infinity,
  addUsedSchema: true,
}

export default class Ajv {
  opts: InstanceOptions
  errors?: ErrorObject[] | null // errors from the last validation
  logger: Logger
  // shared external scope values for compiled functions
  readonly scope = new ValueScope({scope: {}, prefixes: EXT_SCOPE_NAMES})
  readonly schemas: {[key: string]: SchemaEnv | undefined} = {}
  readonly refs: {[ref: string]: SchemaEnv | string | undefined} = {}
  readonly formats: {[name: string]: AddedFormat | undefined} = {}
  readonly RULES: ValidationRules
  readonly _compilations: Set<SchemaEnv> = new Set()
  private readonly _loading: {[ref: string]: Promise<SchemaObject> | undefined} = {}
  private readonly _cache: CacheInterface
  private readonly _metaOpts: InstanceOptions

  static ValidationError = ValidationError
  static MissingRefError = MissingRefError

  constructor(opts: Options = {}) {
    opts = this.opts = {
      ...optsDefaults,
      ...opts,
      serialize: opts.serialize === false ? (x) => x : opts.serialize ?? stableStringify,
      addUsedSchema: opts.addUsedSchema ?? true,
      validateSchema: opts.validateSchema ?? true,
    }
    this.logger = getLogger(opts.logger)
    const formatOpt = opts.format
    opts.format = false

    this._cache = opts.cache || new Cache()
    this.RULES = getRules()
    checkDeprecatedOptions.call(this, opts)
    this._metaOpts = getMetaSchemaOptions.call(this)

    if (opts.formats) addInitialFormats.call(this)
    this.addVocabulary(["$async"])
    this.addVocabulary(coreVocabulary)
    this.addVocabulary(validationVocabulary)
    this.addVocabulary(applicatorVocabulary)
    this.addVocabulary(formatVocabulary)
    this.addVocabulary(metadataVocabulary)
    this.addVocabulary(contentVocabulary)
    if (opts.keywords) addInitialKeywords.call(this, opts.keywords)
    addDefaultMetaSchema.call(this)
    if (typeof opts.meta == "object") this.addMetaSchema(opts.meta)
    addInitialSchemas.call(this)
    opts.format = formatOpt
  }

  // Validate data using schema
  // Schema will be compiled and cached using as a key JSON serialized with
  // [fast-json-stable-stringify](https://github.com/epoberezkin/fast-json-stable-stringify)
  validate(schema: {$async?: never}, data: unknown): boolean | Promise<unknown>
  validate(schema: SyncSchemaObject | boolean, data: unknown): boolean
  validate<T>(schema: SyncSchemaObject | JSONSchemaType<T>, data: unknown): data is T
  validate(schema: AsyncSchemaObject, data: unknown): Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  validate(schemaKeyRef: Schema | string, data: unknown): boolean | Promise<unknown>
  validate(
    schemaKeyRef: Schema | string, // key, ref or schema object
    data: unknown // to be validated
  ): boolean | Promise<unknown> {
    let v: ValidateFunction | undefined
    if (typeof schemaKeyRef == "string") {
      v = this.getSchema(schemaKeyRef)
      if (!v) throw new Error('no schema with key or ref "' + schemaKeyRef + '"')
    } else {
      const sch = this._addSchema(schemaKeyRef)
      v = sch.validate || this._compileSchemaEnv(sch)
    }

    const valid = v(data)
    if (v.$async !== true) this.errors = v.errors
    return valid
  }

  // Create validation function for passed schema
  // _meta: true if schema is a meta-schema. Used internally to compile meta schemas of custom keywords.
  compile(schema: {$async?: never}, _meta?: boolean): ValidateFunction
  compile(schema: SyncSchemaObject | boolean, _meta?: boolean): SyncValidateFunction
  compile<T>(schema: SyncSchemaObject | JSONSchemaType<T>, _meta?: boolean): ValidateGuard<T>
  compile(schema: AsyncSchemaObject, _meta?: boolean): AsyncValidateFunction
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  compile(schema: Schema, _meta?: boolean): ValidateFunction
  compile(schema: Schema, _meta?: boolean): ValidateFunction {
    const sch = this._addSchema(schema, _meta)
    return sch.validate || this._compileSchemaEnv(sch)
  }

  // Creates validating function for passed schema with asynchronous loading of missing schemas.
  // `loadSchema` option should be a function that accepts schema uri and returns promise that resolves with the schema.
  // TODO allow passing schema URI
  // meta - optional true to compile meta-schema
  compileAsync(schema: {$async?: never}, _meta?: boolean): Promise<ValidateFunction>
  compileAsync(schema: SyncSchemaObject, meta?: boolean): Promise<SyncValidateFunction>
  compileAsync<T>(
    schema: SyncSchemaObject | JSONSchemaType<T>,
    _meta?: boolean
  ): Promise<ValidateGuard<T>>
  compileAsync(schema: AsyncSchemaObject, meta?: boolean): Promise<AsyncValidateFunction>
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  compileAsync(schema: SchemaObject, meta?: boolean): Promise<ValidateFunction>
  compileAsync(schema: SchemaObject, meta?: boolean): Promise<ValidateFunction> {
    if (typeof this.opts.loadSchema != "function") {
      throw new Error("options.loadSchema should be a function")
    }
    const {loadSchema} = this.opts
    return runCompileAsync.call(this, schema, meta)

    async function runCompileAsync(
      this: Ajv,
      _schema: SchemaObject,
      _meta?: boolean
    ): Promise<ValidateFunction> {
      await loadMetaSchema.call(this, _schema.$schema)
      const sch = this._addSchema(_schema, _meta)
      return sch.validate || _compileAsync.call(this, sch)
    }

    async function loadMetaSchema(this: Ajv, $ref?: string): Promise<void> {
      if ($ref && !this.getSchema($ref)) {
        await runCompileAsync.call(this, {$ref}, true)
      }
    }

    async function _compileAsync(this: Ajv, sch: SchemaEnv): Promise<ValidateFunction> {
      try {
        return this._compileSchemaEnv(sch)
      } catch (e) {
        if (!(e instanceof MissingRefError)) throw e
        checkLoaded.call(this, e)
        await loadMissingSchema.call(this, e.missingSchema)
        return _compileAsync.call(this, sch)
      }
    }

    function checkLoaded(this: Ajv, {missingSchema: ref, missingRef}: MissingRefError): void {
      if (this.refs[ref]) {
        throw new Error(`Schema ${ref} is loaded but ${missingRef} cannot be resolved`)
      }
    }

    async function loadMissingSchema(this: Ajv, ref: string): Promise<void> {
      const _schema = await _loadSchema.call(this, ref)
      if (!this.refs[ref]) await loadMetaSchema.call(this, _schema.$schema)
      if (!this.refs[ref]) this.addSchema(_schema, ref, meta)
    }

    async function _loadSchema(this: Ajv, ref: string): Promise<SchemaObject> {
      const p = this._loading[ref]
      if (p) return p
      try {
        return await (this._loading[ref] = loadSchema(ref))
      } finally {
        delete this._loading[ref]
      }
    }
  }

  // Adds schema to the instance
  addSchema(
    schema: Schema | Schema[], // If array is passed, `key` will be ignored
    key?: string, // Optional schema key. Can be passed to `validate` method instead of schema object or id/ref. One schema per instance can have empty `id` and `key`.
    _meta?: boolean, // true if schema is a meta-schema. Used internally, addMetaSchema should be used instead.
    _validateSchema = this.opts.validateSchema // false to skip schema validation. Used internally, option validateSchema should be used instead.
  ): Ajv {
    if (Array.isArray(schema)) {
      for (const sch of schema) this.addSchema(sch, undefined, _meta, _validateSchema)
      return this
    }
    let id: string | undefined
    if (typeof schema === "object") {
      id = schema.$id
      if (id !== undefined && typeof id != "string") throw new Error("schema id must be string")
    }
    key = normalizeId(key || id)
    this._checkUnique(key)
    this.schemas[key] = this._addSchema(schema, _meta, _validateSchema, true)
    return this
  }

  // Add schema that will be used to validate other schemas
  // options in META_IGNORE_OPTIONS are alway set to false
  addMetaSchema(
    schema: SchemaObject,
    key?: string, // schema key
    _validateSchema = this.opts.validateSchema // false to skip schema validation, can be used to override validateSchema option for meta-schema
  ): Ajv {
    this.addSchema(schema, key, true, _validateSchema)
    return this
  }

  //  Validate schema against its meta-schema
  validateSchema(schema: Schema, throwOrLogError?: boolean): boolean | Promise<unknown> {
    if (typeof schema == "boolean") return true
    let $schema: string | SchemaObject | undefined
    $schema = schema.$schema
    if ($schema !== undefined && typeof $schema != "string") {
      throw new Error("$schema must be a string")
    }
    $schema = $schema || this.opts.defaultMeta || defaultMeta.call(this)
    if (!$schema) {
      this.logger.warn("meta-schema not available")
      this.errors = null
      return true
    }
    const valid = this.validate($schema, schema)
    if (!valid && throwOrLogError) {
      const message = "schema is invalid: " + this.errorsText()
      if (this.opts.validateSchema === "log") this.logger.error(message)
      else throw new Error(message)
    }
    return valid
  }

  // Get compiled schema by `key` or `ref`.
  // (`key` that was passed to `addSchema` or full schema reference - `schema.$id` or resolved id)
  getSchema(keyRef: string): ValidateFunction | undefined {
    let sch
    while (typeof (sch = getSchEnv.call(this, keyRef)) == "string") keyRef = sch
    if (sch === undefined) {
      const root = new SchemaEnv({schema: {}})
      sch = resolveSchema.call(this, root, keyRef)
      if (!sch) return
      this.refs[keyRef] = sch
    }
    return sch.validate || this._compileSchemaEnv(sch)
  }

  // Remove cached schema(s).
  // If no parameter is passed all schemas but meta-schemas are removed.
  // If RegExp is passed all schemas with key/id matching pattern but meta-schemas are removed.
  // Even if schema is referenced by other schemas it still can be removed as other schemas have local references.
  removeSchema(schemaKeyRef: Schema | string | RegExp): Ajv {
    if (schemaKeyRef instanceof RegExp) {
      this._removeAllSchemas(this.schemas, schemaKeyRef)
      this._removeAllSchemas(this.refs, schemaKeyRef)
      return this
    }
    switch (typeof schemaKeyRef) {
      case "undefined":
        this._removeAllSchemas(this.schemas)
        this._removeAllSchemas(this.refs)
        this._cache.clear()
        return this
      case "string": {
        const sch = getSchEnv.call(this, schemaKeyRef)
        if (typeof sch == "object") this._cache.del(sch.cacheKey)
        delete this.schemas[schemaKeyRef]
        delete this.refs[schemaKeyRef]
        return this
      }
      case "object": {
        const cacheKey = this.opts.serialize(schemaKeyRef)
        this._cache.del(cacheKey)
        let id = schemaKeyRef.$id
        if (id) {
          id = normalizeId(id)
          delete this.schemas[id]
          delete this.refs[id]
        }
        return this
      }
      default:
        throw new Error("ajv.removeSchema: invalid parameter")
    }
  }

  // add "vocabulary" - a collection of keywords
  addVocabulary(definitions: Vocabulary): Ajv {
    for (const def of definitions) this.addKeyword(def)
    return this
  }

  addKeyword(kwdOrDef: string | KeywordDefinition): Ajv
  addKeyword(
    kwdOrDef: string | KeywordDefinition,
    def?: KeywordDefinition // deprecated
  ): Ajv {
    let keyword: string | string[]
    if (typeof kwdOrDef == "string") {
      keyword = kwdOrDef
      if (typeof def == "object") {
        this.logger.warn("these parameters are deprecated, see docs for addKeyword")
        def.keyword = keyword
      }
    } else if (typeof kwdOrDef == "object" && def === undefined) {
      def = kwdOrDef
      keyword = def.keyword
    } else {
      throw new Error("invalid addKeywords parameters")
    }

    checkKeyword.call(this, keyword, def)
    if (def) keywordMetaschema.call(this, def)

    eachItem(keyword, (kwd) => {
      eachItem(def?.type, (t) => addRule.call(this, kwd, t, def))
    })
    return this
  }

  getKeyword(keyword: string): KeywordDefinition | boolean {
    const rule = this.RULES.all[keyword]
    return typeof rule == "object" ? rule.definition : !!rule
  }

  // Remove keyword
  removeKeyword(keyword: string): Ajv {
    // TODO return type should be Ajv
    const {RULES} = this
    delete RULES.keywords[keyword]
    delete RULES.all[keyword]
    for (const group of RULES.rules) {
      const i = group.rules.findIndex((rule) => rule.keyword === keyword)
      if (i >= 0) group.rules.splice(i, 1)
    }
    return this
  }

  // Add format
  addFormat(name: string, format: Format): Ajv {
    if (typeof format == "string") format = new RegExp(format)
    this.formats[name] = format
    return this
  }

  errorsText(
    errors: ErrorObject[] | null | undefined = this.errors, // optional array of validation errors
    {separator = ", ", dataVar = "data"}: ErrorsTextOptions = {} // optional options with properties `separator` and `dataVar`
  ): string {
    if (!errors || errors.length === 0) return "No errors"
    return errors
      .map((e) => `${dataVar}${e.dataPath} ${e.message}`)
      .reduce((text, msg) => text + msg + separator)
  }

  $dataMetaSchema(metaSchema: SchemaObject, keywordsJsonPointers: string[]): SchemaObject {
    const rules = this.RULES.all
    for (const jsonPointer of keywordsJsonPointers) {
      metaSchema = JSON.parse(JSON.stringify(metaSchema))
      const segments = jsonPointer.split("/").slice(1) // first segment is an empty string
      let keywords = metaSchema
      for (const seg of segments) keywords = keywords[seg] as SchemaObject

      for (const key in rules) {
        const rule = rules[key]
        if (typeof rule != "object") continue
        const {$data} = rule.definition
        const schema = keywords[key] as SchemaObject | undefined
        if ($data && schema) keywords[key] = schemaOrData(schema)
      }
    }

    return metaSchema
  }

  private _removeAllSchemas(
    schemas: {[ref: string]: SchemaEnv | string | undefined},
    regex?: RegExp
  ): void {
    for (const keyRef in schemas) {
      const sch = schemas[keyRef]
      if (!regex || regex.test(keyRef)) {
        if (typeof sch == "string") {
          delete schemas[keyRef]
        } else if (sch && !sch.meta) {
          this._cache.del(sch.cacheKey)
          delete schemas[keyRef]
        }
      }
    }
  }

  private _addSchema(
    schema: Schema,
    meta?: boolean,
    validateSchema = this.opts.validateSchema,
    addSchema = this.opts.addUsedSchema
  ): SchemaEnv {
    if (typeof schema != "object" && typeof schema != "boolean") {
      throw new Error("schema must be object or boolean")
    }
    const cacheKey = this.opts.serialize(schema)
    let sch = this._cache.get(cacheKey)
    if (sch) return sch

    const localRefs = getSchemaRefs.call(this, schema)
    sch = new SchemaEnv({schema, cacheKey, meta, localRefs})
    this._cache.put(sch.cacheKey, sch)
    const id = sch.baseId
    if (addSchema && !id.startsWith("#")) {
      // TODO atm it is allowed to overwrite schemas without id (instead of not adding them)
      if (id) this._checkUnique(id)
      this.refs[id] = sch
    }
    if (validateSchema) this.validateSchema(schema, true)
    return sch
  }

  private _checkUnique(id: string): void {
    if (this.schemas[id] || this.refs[id]) {
      throw new Error(`schema with key or id "${id}" already exists`)
    }
  }

  private _compileSchemaEnv(sch: SchemaEnv): ValidateFunction {
    if (sch.meta) this._compileMetaSchema(sch)
    else compileSchema.call(this, sch)
    if (!sch.validate) throw new Error("ajv implementation error")
    return sch.validate
  }

  private _compileMetaSchema(sch: SchemaEnv): void {
    const currentOpts = this.opts
    this.opts = this._metaOpts
    try {
      compileSchema.call(this, sch)
    } finally {
      this.opts = currentOpts
    }
  }
}

export interface ErrorsTextOptions {
  separator?: string
  dataVar?: string
}

function checkDeprecatedOptions(this: Ajv, opts: Options): void {
  if (opts.errorDataPath !== undefined) this.logger.error("NOT SUPPORTED: option errorDataPath")
  if (opts.schemaId !== undefined) this.logger.error("NOT SUPPORTED: option schemaId")
  if (opts.uniqueItems !== undefined) this.logger.error("NOT SUPPORTED: option uniqueItems")
  if (opts.jsPropertySyntax !== undefined) this.logger.warn("DEPRECATED: option jsPropertySyntax")
  if (opts.unicode !== undefined) this.logger.warn("DEPRECATED: option unicode")
}

function defaultMeta(this: Ajv): string | SchemaObject | undefined {
  const {meta} = this.opts
  this.opts.defaultMeta =
    typeof meta == "object"
      ? meta.$id || meta
      : this.getSchema(META_SCHEMA_ID)
      ? META_SCHEMA_ID
      : undefined
  return this.opts.defaultMeta
}

function getSchEnv(this: Ajv, keyRef: string): SchemaEnv | string | undefined {
  keyRef = normalizeId(keyRef) // TODO tests fail without this line
  return this.schemas[keyRef] || this.refs[keyRef]
}

function addDefaultMetaSchema(this: Ajv): void {
  const {$data, meta} = this.opts
  if ($data) this.addMetaSchema($dataRefSchema, $dataRefSchema.$id, false)
  if (meta === false) return
  const metaSchema = $data
    ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA)
    : draft7MetaSchema
  this.addMetaSchema(metaSchema, META_SCHEMA_ID, false)
  this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID
}

function addInitialSchemas(this: Ajv): void {
  const optsSchemas = this.opts.schemas
  if (!optsSchemas) return
  if (Array.isArray(optsSchemas)) this.addSchema(optsSchemas)
  else for (const key in optsSchemas) this.addSchema(optsSchemas[key], key)
}

function addInitialFormats(this: Ajv): void {
  for (const name in this.opts.formats) {
    const format = this.opts.formats[name]
    this.addFormat(name, format)
  }
}

function addInitialKeywords(this: Ajv, defs: Vocabulary | {[x: string]: KeywordDefinition}): void {
  if (Array.isArray(defs)) {
    this.addVocabulary(defs)
    return
  }
  this.logger.warn("keywords option as map is deprecated, pass array")
  for (const keyword in defs) {
    const def = defs[keyword]
    if (!def.keyword) def.keyword = keyword
    this.addKeyword(def)
  }
}

function getMetaSchemaOptions(this: Ajv): InstanceOptions {
  const metaOpts = {...this.opts}
  for (const opt of META_IGNORE_OPTIONS) delete metaOpts[opt]
  return metaOpts
}

const noLogs = {log() {}, warn() {}, error() {}}

function getLogger(logger?: Partial<Logger> | false): Logger {
  if (logger === false) return noLogs
  if (logger === undefined) return console
  if (logger.log && logger.warn && logger.error) return logger as Logger
  throw new Error("logger must implement log, warn and error methods")
}

const KEYWORD_NAME = /^[a-z_$][a-z0-9_$-]*$/i

function checkKeyword(this: Ajv, keyword: string | string[], def?: KeywordDefinition): void {
  const {RULES} = this
  eachItem(keyword, (kwd) => {
    if (RULES.keywords[kwd]) throw new Error(`Keyword ${kwd} is already defined`)
    if (!KEYWORD_NAME.test(kwd)) throw new Error(`Keyword ${kwd} has invalid name`)
  })
  if (!def) return
  if (def.type) eachItem(def.type, (t) => checkType(t, RULES))
  if (def.$data && !("code" in def || "validate" in def)) {
    throw new Error('$data keyword must have "code" or "validate" function')
  }
}

function addRule(
  this: Ajv,
  keyword: string,
  dataType?: string,
  definition?: KeywordDefinition
): void {
  const {RULES} = this
  let ruleGroup = RULES.rules.find(({type: t}) => t === dataType)
  if (!ruleGroup) {
    ruleGroup = {type: dataType, rules: []}
    RULES.rules.push(ruleGroup)
  }
  RULES.keywords[keyword] = true
  if (!definition) return

  const rule: Rule = {keyword, definition}
  if (definition.before) addBeforeRule.call(this, ruleGroup, rule, definition.before)
  else ruleGroup.rules.push(rule)
  RULES.all[keyword] = rule
  definition.implements?.forEach((kwd) => this.addKeyword(kwd))
}

function addBeforeRule(this: Ajv, ruleGroup: RuleGroup, rule: Rule, before: string): void {
  const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before)
  if (i >= 0) {
    ruleGroup.rules.splice(i, 0, rule)
  } else {
    ruleGroup.rules.push(rule)
    this.logger.warn(`rule ${before} is not defined`)
  }
}

function keywordMetaschema(this: Ajv, def: KeywordDefinition): void {
  let {metaSchema} = def
  if (metaSchema === undefined) return
  if (def.$data && this.opts.$data) metaSchema = schemaOrData(metaSchema)
  def.validateSchema = this.compile(metaSchema, true)
}

const $dataRef = {
  $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
}

function schemaOrData(schema: Schema): SchemaObject {
  return {anyOf: [schema, $dataRef]}
}

module.exports = Ajv
module.exports.default = Ajv