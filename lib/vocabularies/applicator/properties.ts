import {CodeKeywordDefinition} from "../../types"
import {schemaProperties, propertyInData} from "../util"
import {applySubschema, Expr} from "../../compile/subschema"

const def: CodeKeywordDefinition = {
  keyword: "properties",
  type: "object",
  schemaType: "object",
  code(cxt) {
    const {gen, ok, schema, data, it} = cxt
    // TODO
    // if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === undefined) {
    //   remove all additional properties - it will fix skipped tests
    // }
    const properties = schemaProperties(it, schema)
    if (properties.length === 0) return
    const valid = gen.name("valid")

    for (const prop of properties) {
      if (hasDefault(prop)) {
        applyPropertySchema(prop)
      } else {
        gen.if(propertyInData(data, prop, it.opts.ownProperties))
        applyPropertySchema(prop)
        if (!it.allErrors) gen.else().code(`var ${valid} = true;`)
        gen.endIf()
      }
      ok(valid)
    }

    function hasDefault(prop: string): boolean | undefined {
      return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== undefined
    }

    function applyPropertySchema(prop: string) {
      applySubschema(
        it,
        {
          keyword: "properties",
          schemaProp: prop,
          dataProp: prop,
          expr: Expr.Const,
        },
        valid
      )
    }
  },
}

module.exports = def
