// The overview's JSON Schema and a minimal check against it, shared by the suites that hold a
// value to the schema: the overview's own and the Solution map's.
import fs from 'node:fs';
import path from 'node:path';
import { OVERVIEW_DIR } from '../overview.mjs';

export const SCHEMA = JSON.parse(fs.readFileSync(path.join(OVERVIEW_DIR, 'overview.schema.json'), 'utf8'));

/** A minimal JSON Schema check: type, const, enum, required, properties, additionalProperties: false, items, $ref, oneOf, anyOf, pattern, maxLength, minimum. */
export function validate(value, schema = SCHEMA, at = '$', root = schema) {
  const errs = [];
  if (schema.$ref) return validate(value, schema.$ref.replace('#/$defs/', '').split('/').reduce((s, k) => s[k], root.$defs), at, root);
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validate(value, s, at, root).length === 0).length;
    if (n !== 1) return [`${at}: matches ${n} of oneOf`];
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validate(value, s, at, root).length === 0)) return [`${at}: matches none of anyOf`];
  const types = schema.type ? [].concat(schema.type) : null;
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types && !types.some((t) => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) return [`${at}: ${typeOf(value)} is not ${types.join('|')}`];
  if ('const' in schema && value !== schema.const) errs.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: "${value}" does not match ${schema.pattern}`);
  if (typeof value === 'string' && schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}: lacks "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(v, schema.properties[k], `${at}.${k}`, root));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`, root)));
  return errs;
}
