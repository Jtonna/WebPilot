// In-memory storage for accessibility tree refs
// Maps tab_id -> Map<ref, backendDOMNodeId>
const refMappings = new Map();

// Context storage for re-identification after scroll
// Maps tab_id -> Map<ref, { role, name, parentRole, parentName, ancestorContent, ancestorRole }>
const refContextMappings = new Map();

export function storeRefs(tab_id, refs) {
  // refs is an object like { "e1": 123, "e2": 456, ... }
  refMappings.set(tab_id, new Map(Object.entries(refs)));
}

export function getBackendNodeId(tab_id, ref) {
  const tabRefs = refMappings.get(tab_id);
  if (!tabRefs) return null;
  return tabRefs.get(ref) || null;
}

export function clearRefs(tab_id) {
  refMappings.delete(tab_id);
  refContextMappings.delete(tab_id);
}

export function hasRefs(tab_id) {
  return refMappings.has(tab_id);
}

/**
 * Store ancestry context for a ref (for re-identification after scroll)
 * @param {number} tab_id - Tab ID
 * @param {string} ref - Element ref (e.g., "e16")
 * @param {Object} context - Ancestry context
 *   - role: Element's accessibility role
 *   - name: Element's accessible name (truncated)
 *   - parentRole: Parent element's role
 *   - parentName: Parent element's name
 *   - ancestorContent: Nearest ancestor's substantial text content
 *   - ancestorRole: That ancestor's role
 */
export function storeRefContext(tab_id, ref, context) {
  if (!refContextMappings.has(tab_id)) {
    refContextMappings.set(tab_id, new Map());
  }
  refContextMappings.get(tab_id).set(ref, context);
}

/**
 * Get context for a ref
 * @param {number} tab_id - Tab ID
 * @param {string} ref - Element ref
 * @returns {Object|null} Context object or null
 */
export function getRefContext(tab_id, ref) {
  const tabContext = refContextMappings.get(tab_id);
  if (!tabContext) return null;
  return tabContext.get(ref) || null;
}

/**
 * Find a ref by matching its ancestry context.
 * Used after scroll to re-identify elements that may have moved.
 * @param {number} tab_id - Tab ID
 * @param {Object} targetContext - The context to match against
 * @returns {string|null} Matching ref or null
 */
export function findRefByAncestry(tab_id, targetContext) {
  const tabContexts = refContextMappings.get(tab_id);
  if (!tabContexts) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const [ref, context] of tabContexts) {
    let score = 0;

    // Must match role
    if (context.role !== targetContext.role) continue;

    // Score based on matching properties
    if (context.name === targetContext.name) score += 1;
    if (context.parentRole === targetContext.parentRole) score += 1;
    if (context.parentName === targetContext.parentName) score += 2;

    // Ancestor content is the strongest signal
    if (context.ancestorContent && targetContext.ancestorContent) {
      if (context.ancestorContent === targetContext.ancestorContent) {
        score += 10;
      } else if (context.ancestorContent.includes(targetContext.ancestorContent.slice(0, 50)) ||
                 targetContext.ancestorContent.includes(context.ancestorContent.slice(0, 50))) {
        score += 5; // Partial match
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = ref;
    }
  }

  // Require minimum score to avoid false matches
  return bestScore >= 3 ? bestMatch : null;
}
