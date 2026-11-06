/**
 * Batch node resolution: run a formatter-supplied page-side function against
 * specific DOM nodes (by CDP backendDOMNodeId). Pure module, no chrome access
 * at import time. No eval (Discord CSP): declarations are built by string concat.
 */

const MAX_CALLS = 10;
const MAX_ENTRIES = 500;
const MAX_DECL_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const OBJECT_GROUP = 'webpilot-resolve';

export function validateResolveParams(params) {
  if (!params || typeof params.tab_id !== 'number' || Number.isNaN(params.tab_id)) {
    throw new Error('tab_id must be a number');
  }
  const calls = params.calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('calls must be a non-empty array');
  }
  if (calls.length > MAX_CALLS) {
    throw new Error(`calls exceeds maximum of ${MAX_CALLS}`);
  }
  calls.forEach((call, i) => {
    if (!call || typeof call !== 'object') throw new Error(`calls[${i}] must be an object`);
    const fd = call.functionDeclaration;
    if (typeof fd !== 'string') throw new Error(`calls[${i}].functionDeclaration must be a string`);
    if (fd.length > MAX_DECL_BYTES) throw new Error(`calls[${i}].functionDeclaration exceeds ${MAX_DECL_BYTES} bytes`);
    if (!/^\s*function\b/.test(fd)) throw new Error(`calls[${i}].functionDeclaration must be a function expression`);
    const hasIds = call.backendNodeIds !== undefined;
    const hasRefs = call.refs !== undefined;
    if (hasIds === hasRefs) throw new Error(`calls[${i}] must have exactly one of backendNodeIds or refs`);
    if (hasIds) {
      if (!Array.isArray(call.backendNodeIds) || !call.backendNodeIds.every((n) => typeof n === 'number')) {
        throw new Error(`calls[${i}].backendNodeIds must be an array of numbers`);
      }
      if (call.backendNodeIds.length > MAX_ENTRIES) throw new Error(`calls[${i}].backendNodeIds exceeds ${MAX_ENTRIES} entries`);
    } else {
      if (!Array.isArray(call.refs) || !call.refs.every((r) => typeof r === 'string')) {
        throw new Error(`calls[${i}].refs must be an array of strings`);
      }
      if (call.refs.length > MAX_ENTRIES) throw new Error(`calls[${i}].refs exceeds ${MAX_ENTRIES} entries`);
    }
  });
}

export function buildBatchDeclaration(src) {
  return 'function(){ var f=(' + src + '); return Array.prototype.map.call(arguments,function(el){ if(!el) return null; try{ var v=f.call(el); return v===undefined?null:v; }catch(e){ return null; } }); }';
}

function errMsg(e) {
  return (e && e.message) ? e.message : String(e);
}

export async function runResolveCalls(send, calls) {
  const results = [];
  const errors = [];
  try {
    for (const call of calls) {
      const ids = call.backendNodeIds;
      const nulls = () => ids.map(() => null);
      try {
        const objectIds = await Promise.all(ids.map(async (id) => {
          if (id === null || id === undefined) return null;
          try {
            const r = await send('DOM.resolveNode', { backendNodeId: id, objectGroup: OBJECT_GROUP });
            return (r && r.object && r.object.objectId) || null;
          } catch {
            return null;
          }
        }));
        const first = objectIds.find((o) => o);
        if (!first) {
          results.push(nulls());
          errors.push(null);
          continue;
        }
        const res = await send('Runtime.callFunctionOn', {
          objectId: first,
          functionDeclaration: buildBatchDeclaration(call.functionDeclaration),
          arguments: objectIds.map((o) => (o ? { objectId: o } : { value: null })),
          returnByValue: true
        });
        if (res && res.exceptionDetails) {
          const ed = res.exceptionDetails;
          const msg = (ed.exception && ed.exception.description) || ed.text || 'exception in resolve function';
          results.push(nulls());
          errors.push(String(msg));
          continue;
        }
        const value = res && res.result ? res.result.value : undefined;
        if (!Array.isArray(value)) {
          results.push(nulls());
          errors.push('resolve function returned a non-array result');
          continue;
        }
        let size = 0;
        try { size = JSON.stringify(value).length; } catch { size = Infinity; }
        if (size > MAX_RESULT_BYTES) {
          results.push(nulls());
          errors.push(`result exceeds ${MAX_RESULT_BYTES} bytes`);
          continue;
        }
        const out = ids.map((_, i) => (value[i] === undefined ? null : value[i]));
        results.push(out);
        errors.push(null);
      } catch (e) {
        results.push(nulls());
        errors.push(errMsg(e));
      }
    }
  } finally {
    try {
      await send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
    } catch {
      // ignore
    }
  }
  return { results, errors };
}
