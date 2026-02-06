/**
 * Zillow Full Property Detail Page Formatter
 * Extracts property information from standalone /homedetails/ pages.
 */

export function formatDetailPage(context) {
  const { nodeMap, getRef, getNodeName, getNodeRole, getNodeUrl, findChildrenByRole, rootNode } = context;

  // Extract property address - try multiple sources
  let address = null;

  // Source 1: Look for heading with address format
  const headings = findChildrenByRole(rootNode.nodeId, 'heading');
  for (const h of headings) {
    const name = getNodeName(h);
    if (name && name.includes(',') && !name.startsWith('$') && name.length > 10) {
      address = name;
      break;
    }
  }

  // Source 2: Extract from URL if heading not found
  if (!address) {
    const url = getNodeUrl(rootNode);
    if (url && url.includes('/homedetails/')) {
      // URL format: /homedetails/3124-E-Madison-Ave-Fresno-CA-93702/18754890_zpid/
      const parts = url.split('/homedetails/')[1]?.split('/')[0];
      if (parts) {
        // Convert dashes to spaces and add commas
        address = parts.replace(/-/g, ' ').replace(/\s+CA\s+/, ', CA ').replace(/\s+(\d{5})/, ', $1');
      }
    }
  }

  // Extract price from heading
  let price = null;
  for (const h of headings) {
    const name = getNodeName(h);
    if (name && name.startsWith('$')) {
      price = name;
      break;
    }
  }

  // Extract beds, baths, sqft from text - be more selective
  let beds = null;
  let baths = null;
  let sqft = null;

  const texts = collectTexts(rootNode.nodeId, context);

  // First pass: Look for grouped bed/bath/sqft patterns
  for (const t of texts) {
    // Pattern like "3 bd | 2 ba | 1,898 sqft"
    if (t.includes('bd') && t.includes('ba') && t.includes('sqft')) {
      const bdMatch = t.match(/(\d+)\s*bd/i);
      const baMatch = t.match(/(\d+)\s*ba/i);
      const sqftMatch = t.match(/([\d,]+)\s*sqft/i);

      if (bdMatch) beds = parseInt(bdMatch[1], 10);
      if (baMatch) baths = parseInt(baMatch[1], 10);
      if (sqftMatch) sqft = parseInt(sqftMatch[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // Second pass: Individual patterns if not found
  if (!beds || !baths || !sqft) {
    for (const t of texts) {
      if (!beds && /^\d+\s*bd$/i.test(t.trim())) {
        beds = parseInt(t.match(/(\d+)/)[1], 10);
      }
      if (!baths && /^\d+\s*ba$/i.test(t.trim())) {
        baths = parseInt(t.match(/(\d+)/)[1], 10);
      }
      if (!sqft && /^[\d,]+\s*sqft$/i.test(t.trim())) {
        sqft = parseInt(t.match(/([\d,]+)/)[1].replace(/,/g, ''), 10);
      }
    }
  }

  // Extract tabs if present
  const tabs = [];
  const tabNodes = findChildrenByRole(rootNode.nodeId, 'tab');
  for (const tab of tabNodes) {
    const name = getNodeName(tab);
    const selected = isSelected(tab);
    tabs.push([name, getRef(tab), selected]);
  }

  // Extract key action buttons
  let saveRef = null;
  let shareRef = null;
  let tourRef = null;
  let contactRef = null;

  const buttons = findChildrenByRole(rootNode.nodeId, 'button');
  for (const btn of buttons) {
    const name = getNodeName(btn);
    if (!saveRef && name === 'Save') {
      saveRef = getRef(btn);
    } else if (!shareRef && name === 'Share') {
      shareRef = getRef(btn);
    } else if (!tourRef && (name === 'Request a tour' || name.includes('Tour'))) {
      tourRef = getRef(btn);
    } else if (!contactRef && (name === 'Contact agent' || name.includes('Contact'))) {
      contactRef = getRef(btn);
    }
  }

  // Extract property type, year built, lot size from static text
  let propertyType = null;
  let yearBuilt = null;
  let lotSize = null;

  for (const t of texts) {
    const typeMatch = t.match(/^(Single Family|Condo|Townhouse|Multi Family|Apartment|Lot\/Land|Mobile\/Manufactured)$/i);
    if (typeMatch && !propertyType) {
      propertyType = typeMatch[1];
    }

    const yearMatch = t.match(/Built in (\d{4})/i) || t.match(/^(\d{4})$/) && t.length === 4;
    if (yearMatch && !yearBuilt) {
      yearBuilt = parseInt(yearMatch[1], 10);
    }

    const lotMatch = t.match(/([\d,]+)\s*(sqft|acres?)\s*lot/i);
    if (lotMatch && !lotSize) {
      lotSize = `${lotMatch[1]} ${lotMatch[2]}`;
    }
  }

  return {
    address,
    price,
    beds,
    baths,
    sqft,
    propertyType,
    yearBuilt,
    lotSize,
    saveRef,
    shareRef,
    tourRef,
    contactRef,
    _tabSchema: tabs.length > 0 ? ['label', 'ref', 'selected'] : null,
    tabs: tabs.length > 0 ? tabs : null
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
