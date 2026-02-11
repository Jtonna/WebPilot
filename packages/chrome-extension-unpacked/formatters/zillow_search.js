/**
 * Zillow Search Results Page Formatter
 * Extracts search controls, filters, listings, pagination, and sort from search results.
 */

export function formatSearchPage(context) {
  const { nodeMap, getRef, getNodeName, getNodeRole, getNodeUrl, findChildrenByRole, rootNode } = context;

  // --- Search controls ---
  let searchRef = null;
  let searchValue = null;
  let submitRef = null;
  let clearRef = null;

  // --- Filters ---
  const filters = [];
  let saveSearchRef = null;

  // --- Results metadata ---
  let resultCount = null;
  let sortLabel = null;
  let sortRef = null;

  // Find the filters container (may be role="region" or role="generic" depending on Zillow's markup)
  let filtersRegion = null;
  let mainNode = null;

  for (const [, node] of nodeMap) {
    if (getNodeName(node) === 'filters' && (getNodeRole(node) === 'region' || getNodeRole(node) === 'generic')) {
      filtersRegion = node;
      break;
    }
  }

  // Find main landmark
  for (const [, node] of nodeMap) {
    if (getNodeRole(node) === 'main') {
      mainNode = node;
      break;
    }
  }

  // Extract search controls from filters region
  if (filtersRegion) {
    const comboboxes = findChildrenByRole(filtersRegion.nodeId, 'combobox');
    for (const cb of comboboxes) {
      const name = getNodeName(cb);
      if (name.toLowerCase().includes('search') || name === 'Search') {
        searchRef = getRef(cb);
        // Get current value from StaticText child
        const texts = collectTexts(cb.nodeId, context);
        if (texts.length > 0) {
          searchValue = texts[0];
        }
      }
    }

    const buttons = findChildrenByRole(filtersRegion.nodeId, 'button');
    const filterNames = ['For Sale', 'For Rent', 'Sold', 'Price', 'Beds & Baths', 'Home Type', 'More'];

    for (const btn of buttons) {
      const name = getNodeName(btn);

      if (name === 'Submit Search') {
        submitRef = getRef(btn);
        continue;
      }

      // Note: Clear button may not appear in a11y tree (hidden until hover/focus)
      if (name === 'Clear search text' || name === 'Clear' || name.toLowerCase().includes('clear')) {
        clearRef = getRef(btn);
        continue;
      }

      if (name === 'Save search') {
        saveSearchRef = getRef(btn);
        continue;
      }

      // Check if this is a filter button
      if (filterNames.some(f => name.startsWith(f) || name.includes(f))) {
        const expanded = getExpandedState(btn);
        filters.push([name, getRef(btn), expanded]);
      }
    }
  }

  const activeFilter = filtersRegion ? extractActiveFilter(filtersRegion, context) : null;

  // Extract result count from main
  if (mainNode) {
    const headings = findChildrenByRole(mainNode.nodeId, 'heading');
    for (const h of headings) {
      const name = getNodeName(h);
      if (name && name.includes('result')) {
        resultCount = name;
        break;
      }
    }
  }

  // Extract sort control
  for (const [, node] of nodeMap) {
    const name = getNodeName(node);
    if (getNodeRole(node) === 'button' && name && name.includes('Sort')) {
      sortLabel = name.replace(/^Sort(?:\s*options)?,?\s*/i, '').replace(/ selected$/, '');
      sortRef = getRef(node);
      break;
    }
  }

  // --- Listings ---
  const listings = [];

  if (mainNode) {
    const listItems = findChildrenByRole(mainNode.nodeId, 'listitem');
    for (const li of listItems) {
      const listing = extractSearchListing(li, context);
      if (listing) {
        listings.push(listing);
      }
    }
  }

  // --- Pagination ---
  let prevRef = null;
  let prevDisabled = false;
  let nextRef = null;
  let nextUrl = null;

  for (const [, node] of nodeMap) {
    const role = getNodeRole(node);
    const name = getNodeName(node);

    if (role === 'link' && name === 'Previous page') {
      prevRef = getRef(node);
      prevDisabled = isDisabled(node);
    }
    if (role === 'link' && name === 'Next page') {
      nextRef = getRef(node);
      nextUrl = getNodeUrl(node);
    }
  }

  return {
    search: {
      ref: searchRef,
      value: searchValue,
      submitRef,
      clearRef
    },
    _filterSchema: ['label', 'ref', 'expanded'],
    filters,
    activeFilter,
    saveSearchRef,
    resultCount,
    sort: sortLabel ? { label: sortLabel, ref: sortRef } : null,
    _listingSchema: ['url', 'price', 'beds', 'baths', 'sqft', 'status', 'address', 'agent', 'saveRef', 'ref'],
    listings,
    listingCount: listings.length,
    pagination: {
      prevRef: prevDisabled ? null : prevRef,
      nextRef,
      nextUrl
    }
  };
}

/**
 * Extract a single listing from a listitem node in search results.
 */
function extractSearchListing(listitemNode, context) {
  const { nodeMap, getRef, getNodeName, getNodeRole, getNodeUrl, findChildrenByRole } = context;

  // Find the main property link (contains /homedetails/)
  const links = findChildrenByRole(listitemNode.nodeId, 'link');
  const propertyLink = links.find(l => {
    const url = getNodeUrl(l);
    return url && url.includes('/homedetails/');
  });
  if (!propertyLink) return null;

  const url = getNodeUrl(propertyLink);
  const listingRef = getRef(propertyLink);

  // Address from the first link name that contains a comma
  let address = null;
  for (const link of links) {
    const name = getNodeName(link);
    if (name && name.includes(',') && !name.startsWith('$')) {
      address = name;
      break;
    }
  }

  // Collect all texts for parsing
  const texts = collectTexts(listitemNode.nodeId, context);

  // Price: first text starting with $
  let price = null;
  for (const t of texts) {
    if (t.startsWith('$')) {
      price = t;
      break;
    }
  }

  // Beds, baths, sqft from list items
  let beds = null;
  let baths = null;
  let sqft = null;

  const innerLists = findChildrenByRole(listitemNode.nodeId, 'list');
  for (const list of innerLists) {
    const items = findChildrenByRole(list.nodeId, 'listitem');
    for (const item of items) {
      const itemTexts = collectTexts(item.nodeId, context);
      const joined = itemTexts.join(' ').trim();

      const bdMatch = joined.match(/(\d+)\s*bd/);
      const baMatch = joined.match(/(\d+)\s*ba/);
      const sqftMatch = joined.match(/([\d,]+)\s*sqft/);

      if (bdMatch && !beds) beds = parseInt(bdMatch[1], 10);
      if (baMatch && !baths) baths = parseInt(baMatch[1], 10);
      if (sqftMatch && !sqft) sqft = parseInt(sqftMatch[1].replace(/,/g, ''), 10);
    }
  }

  // Status: "- Active", "- Pending", etc.
  // Note: Often not present in search results accessibility tree
  let status = null;
  for (const t of texts) {
    const statusMatch = t.match(/^-?\s*(Active|Pending|Contingent|Coming Soon)$/i);
    if (statusMatch) {
      status = statusMatch[1];
      break;
    }
  }

  // Agent/broker name: typically an all-caps text or "MLS ID" format
  // Note: Often not present in search results accessibility tree
  let agent = null;
  for (const t of texts) {
    // Pattern 1: All-caps names
    if (t !== price && t !== address && !t.startsWith('$') && !t.startsWith('-') &&
        t === t.toUpperCase() && t.length > 3 && /^[A-Z\s&.,]+$/.test(t)) {
      agent = t;
      break;
    }
  }
  // Pattern 2: "MLS ID #..." format (fallback)
  if (!agent) {
    for (const t of texts) {
      if (t.startsWith('MLS ID') || t.startsWith('Listing provided by')) {
        agent = t;
        break;
      }
    }
  }

  // Save button
  let saveRef = null;
  const buttons = findChildrenByRole(listitemNode.nodeId, 'button');
  for (const btn of buttons) {
    if (getNodeName(btn) === 'Save') {
      saveRef = getRef(btn);
      break;
    }
  }

  return [url, price, beds, baths, sqft, status, address, agent, saveRef, listingRef];
}

/**
 * Check if a node has the expanded property and return its value.
 */
function getExpandedState(node) {
  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.name === 'expanded') {
        return prop.value?.value === true;
      }
    }
  }
  return false;
}

/**
 * Check if a node is disabled.
 */
function isDisabled(node) {
  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.name === 'disabled') {
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

/**
 * Read the checked property from a node.
 * Returns true, false, "mixed", or null if not present.
 */
function getCheckedState(node) {
  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.name === 'checked') {
        const val = prop.value?.value;
        if (val === 'mixed') return 'mixed';
        if (val === true) return true;
        if (val === false) return false;
        return val ?? null;
      }
    }
  }
  return null;
}

/**
 * Read the pressed property from a node.
 * Returns true, false, or null if not present.
 */
function getPressedState(node) {
  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.name === 'pressed') {
        const val = prop.value?.value;
        if (val === true) return true;
        if (val === false) return false;
        return val ?? null;
      }
    }
  }
  return null;
}

/**
 * Check if an option node is selected.
 */
function getSelectedState(node) {
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
 * Read the accessible value from a node (for textbox, combobox, slider).
 * Returns the string value or '' if not found.
 */
function getNodeValue(node) {
  return node.value?.value ?? '';
}

/**
 * Extract the contents of an open filter dialog within the filters region.
 * Returns null if no dialog is open.
 */
function extractActiveFilter(filtersRegion, context) {
  const { nodeMap, getRef, getNodeName, getNodeRole, findChildrenByRole } = context;

  const dialogs = findChildrenByRole(filtersRegion.nodeId, 'dialog');
  if (dialogs.length === 0) return null;

  const dialog = dialogs[0];

  // Dialog name: prefer the dialog's accessible name, fall back to first heading
  let name = getNodeName(dialog);
  if (!name) {
    const headings = findChildrenByRole(dialog.nodeId, 'heading');
    if (headings.length > 0) {
      name = getNodeName(headings[0]) || null;
    }
  }

  const items = [];

  function walk(nodeId) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = getNodeRole(node);
    const nodeName = getNodeName(node);

    switch (role) {
      case 'heading':
        items.push(['heading', nodeName, null, null]);
        // Recurse into heading children (headings can contain text structure)
        if (node.childIds) {
          for (const childId of node.childIds) walk(childId);
        }
        return;

      case 'group':
        items.push(['group', nodeName, null, null]);
        if (node.childIds) {
          for (const childId of node.childIds) walk(childId);
        }
        return;

      case 'radio':
        items.push(['radio', nodeName, getRef(node), getCheckedState(node)]);
        return;

      case 'checkbox':
        items.push(['checkbox', nodeName, getRef(node), getCheckedState(node)]);
        return;

      case 'button':
        if (nodeName) {
          items.push(['button', nodeName, getRef(node), getPressedState(node)]);
        }
        return;

      case 'textbox':
        items.push(['textbox', nodeName, getRef(node), getNodeValue(node)]);
        return;

      case 'combobox':
        items.push(['combobox', nodeName, getRef(node), getNodeValue(node)]);
        // Expose option children so AI can see and select available values
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeMap.get(childId);
            if (!child) continue;
            const childRole = getNodeRole(child);
            if (childRole === 'option') {
              items.push(['option', getNodeName(child), getRef(child), getSelectedState(child)]);
            } else if (childRole === 'listbox' && child.childIds) {
              // Options may be nested inside a listbox child
              for (const optId of child.childIds) {
                const opt = nodeMap.get(optId);
                if (opt && getNodeRole(opt) === 'option') {
                  items.push(['option', getNodeName(opt), getRef(opt), getSelectedState(opt)]);
                }
              }
            }
          }
        }
        return;

      case 'slider':
        items.push(['slider', nodeName, getRef(node), getNodeValue(node)]);
        return;

      default:
        // For all other roles, recurse into children without emitting
        if (node.childIds) {
          for (const childId of node.childIds) walk(childId);
        }
        return;
    }
  }

  // Walk all children of the dialog
  if (dialog.childIds) {
    for (const childId of dialog.childIds) {
      walk(childId);
    }
  }

  // Find the Apply button ref
  let applyRef = null;
  for (const item of items) {
    if (item[0] === 'button' && item[1] === 'Apply') {
      applyRef = item[2];
      break;
    }
  }

  return {
    name,
    _schema: ['type', 'label', 'ref', 'state'],
    items,
    applyRef
  };
}
