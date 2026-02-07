/**
 * Zillow Property Detail Overlay Formatter
 * Extracts property detail data from the overlay region shown on search results.
 */

export function formatDetailOverlay(overlayRegion, context) {
  const { getRef, getNodeName, getNodeRole, getNodeUrl, findChildrenByRole } = context;

  const address = getNodeName(overlayRegion);

  // --- Navigation buttons ---
  let backRef = null;
  let saveRef = null;
  let shareRef = null;
  let hideRef = null;
  let moreRef = null;

  const buttons = findChildrenByRole(overlayRegion.nodeId, 'button');
  for (const btn of buttons) {
    const name = getNodeName(btn);
    if (name === 'Back to listing') {
      backRef = getRef(btn);
    } else if (name === 'Save') {
      // Take the first Save button (there may be multiples)
      if (!saveRef) saveRef = getRef(btn);
    } else if (name === 'Share') {
      shareRef = getRef(btn);
    } else if (name === 'Hide') {
      hideRef = getRef(btn);
    } else if (name === 'More') {
      moreRef = getRef(btn);
    }
  }

  // --- Tabs ---
  let activeTab = null;
  const tabs = [];

  const tabNodes = findChildrenByRole(overlayRegion.nodeId, 'tab');
  for (const tab of tabNodes) {
    const name = getNodeName(tab);
    const selected = isSelected(tab);
    if (selected) activeTab = name;
    tabs.push([name, getRef(tab), selected]);
  }

  // --- Price ---
  let price = null;
  const texts = collectTexts(overlayRegion.nodeId, context);
  for (const t of texts) {
    if (t.startsWith('$') && !price) {
      price = t;
      break;
    }
  }

  // --- Property link ---
  let detailUrl = null;
  const links = findChildrenByRole(overlayRegion.nodeId, 'link');
  for (const link of links) {
    const url = getNodeUrl(link);
    if (url && url.includes('/homedetails/')) {
      detailUrl = url;
      break;
    }
  }

  return {
    address,
    detailUrl,
    price,
    backRef,
    saveRef,
    shareRef,
    hideRef,
    moreRef,
    activeTab,
    _tabSchema: ['label', 'ref', 'selected'],
    tabs
  };
}

/**
 * Check if a tab node is selected.
 */
function isSelected(node) {
  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.name === 'selected') {
        return prop.value?.value === true;
      }
    }
  }
  return false;
}

/**
 * Collect all StaticText values from descendants of a node.
 */
function collectTexts(nodeId, context) {
  const { nodeMap, getNodeName, getNodeRole } = context;
  const texts = [];

  function walk(id) {
    const node = nodeMap.get(id);
    if (!node) return;
    if (getNodeRole(node) === 'StaticText') {
      const name = getNodeName(node);
      if (name && name.trim()) texts.push(name.trim());
      return;
    }
    if (node.childIds) {
      for (const childId of node.childIds) {
        walk(childId);
      }
    }
  }
  walk(nodeId);
  return texts;
}
