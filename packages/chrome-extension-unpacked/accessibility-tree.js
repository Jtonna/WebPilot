export function formatAccessibilityTree(nodes) {
  return defaultFormatter(nodes);
}

function defaultFormatter(nodes) {
  const nodeMap = new Map();
  const refMap = new Map();
  const refs = {};
  let refCounter = 1;

  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  function shouldInclude(node) {
    if (node.ignored) return false;
    const role = node.role?.value;
    if (!role || role === 'none' || role === 'generic') {
      if (!node.name?.value) return false;
    }
    return true;
  }

  function getRef(node) {
    const nodeId = node.nodeId;
    if (!refMap.has(nodeId)) {
      const ref = `e${refCounter++}`;
      refMap.set(nodeId, ref);
      if (node.backendDOMNodeId) {
        refs[ref] = node.backendDOMNodeId;
      }
    }
    return refMap.get(nodeId);
  }

  function extractNodeInfo(node) {
    const role = node.role?.value || 'unknown';
    const name = node.name?.value || '';
    const props = [];

    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'level' && prop.value?.value !== undefined) {
          props.push(`level=${prop.value.value}`);
        }
        if (prop.name === 'url' && prop.value?.value) {
          props.push(`url=${prop.value.value}`);
        }
        if (prop.name === 'focusable' && prop.value?.value === true) {
          props.push('focusable');
        }
        if (prop.name === 'checked' && prop.value?.value !== undefined) {
          props.push(`checked=${prop.value.value}`);
        }
        if (prop.name === 'selected' && prop.value?.value === true) {
          props.push('selected');
        }
        if (prop.name === 'expanded' && prop.value?.value !== undefined) {
          props.push(`expanded=${prop.value.value}`);
        }
        if (prop.name === 'disabled' && prop.value?.value === true) {
          props.push('disabled');
        }
      }
    }

    return { role, name, props };
  }

  function formatNode(nodeId, depth = 0) {
    const node = nodeMap.get(nodeId);
    if (!node) return '';

    const lines = [];
    const indent = '  '.repeat(depth);

    if (shouldInclude(node)) {
      const { role, name, props } = extractNodeInfo(node);
      const ref = getRef(node);

      let line = `${indent}- ${role}`;
      if (name) {
        const truncatedName = name.length > 80 ? name.substring(0, 77) + '...' : name;
        line += ` "${truncatedName.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
      }
      line += ` [ref=${ref}]`;
      if (props.length > 0) {
        line += ` [${props.join(', ')}]`;
      }
      lines.push(line);

      if (node.childIds) {
        for (const childId of node.childIds) {
          const childOutput = formatNode(childId, depth + 1);
          if (childOutput) lines.push(childOutput);
        }
      }
    } else if (node.childIds) {
      for (const childId of node.childIds) {
        const childOutput = formatNode(childId, depth);
        if (childOutput) lines.push(childOutput);
      }
    }

    return lines.join('\n');
  }

  const rootNode = nodes.find(n => !n.parentId);
  if (!rootNode) {
    return { tree: '', elementCount: 0, refs: {} };
  }

  const tree = formatNode(rootNode.nodeId);

  return {
    tree,
    elementCount: refCounter - 1,
    refs
  };
}

/**
 * Extract ancestry context for a node.
 * Walks up the tree to find identifying information.
 *
 * @param {Object} node - The accessibility node
 * @param {Map} nodeMap - Map of nodeId -> node for parent lookup
 * @returns {Object} Context with role, name, parent info, and ancestor content
 */
export function extractAncestryContext(node, nodeMap) {
  const context = {
    role: node.role?.value,
    name: node.name?.value?.slice(0, 100),
  };

  // Get parent info
  if (node.parentId) {
    const parent = nodeMap.get(node.parentId);
    if (parent) {
      context.parentRole = parent.role?.value;
      context.parentName = parent.name?.value?.slice(0, 100);

      // Walk up to find nearest ancestor with substantial content (post text, etc.)
      let ancestor = parent;
      let depth = 0;
      while (ancestor && !context.ancestorContent && depth < 10) {
        const name = ancestor.name?.value;
        if (name && name.length > 20) {
          context.ancestorContent = name.slice(0, 200);
          context.ancestorRole = ancestor.role?.value;
        }
        ancestor = ancestor.parentId ? nodeMap.get(ancestor.parentId) : null;
        depth++;
      }
    }
  }

  return context;
}
