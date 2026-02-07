/**
 * Zillow Home Page Formatter
 * Extracts search controls, recommended listings, and saved searches from the homepage.
 */

export function formatHomePage(context) {
  const { nodeMap, getRef, getNodeName, getNodeRole, getNodeUrl, findChildrenByRole, rootNode } = context;

  // --- Search controls ---
  let searchRef = null;
  let submitRef = null;
  let searchExpanded = false;

  for (const [, node] of nodeMap) {
    const role = getNodeRole(node);
    const name = getNodeName(node);
    if (role === 'combobox' && name.toLowerCase().includes('search')) {
      searchRef = getRef(node);
      // Check if combobox is expanded (autocomplete visible)
      if (node.properties) {
        for (const prop of node.properties) {
          if (prop.name === 'expanded' && prop.value?.value === true) {
            searchExpanded = true;
          }
        }
      }
    }
    if (role === 'button' && name === 'Submit Search') {
      submitRef = getRef(node);
    }
  }

  // --- Autocomplete suggestions (when search is expanded) ---
  const suggestions = [];
  if (searchExpanded) {
    for (const [, node] of nodeMap) {
      if (getNodeRole(node) === 'listbox') {
        const options = findChildrenByRole(node.nodeId, 'option');
        for (const opt of options) {
          const label = getNodeName(opt);
          if (label) {
            suggestions.push([label, getRef(opt)]);
          }
        }
        break;
      }
    }
  }

  // --- Recommended listings from carousel ---
  const listings = [];

  // Find the carousel container
  for (const [, node] of nodeMap) {
    const name = getNodeName(node);
    if (name === 'Home Recommendations Carousel') {
      // Walk the list items inside the carousel
      const listItems = findChildrenByRole(node.nodeId, 'listitem');
      for (const li of listItems) {
        const listing = extractListing(li, context);
        if (listing) {
          listings.push(listing);
        }
      }
      break;
    }
  }

  // --- Saved searches (Jump Back In cards) ---
  const savedSearches = [];

  for (const [, node] of nodeMap) {
    const role = getNodeRole(node);
    const name = getNodeName(node);
    if (role === 'button' && name === 'Jump Back In Card') {
      const search = extractSavedSearch(node, context);
      if (search) {
        savedSearches.push(search);
      }
    }
  }

  const result = {
    searchRef,
    submitRef,
    _listingSchema: ['url', 'price', 'beds', 'baths', 'sqft', 'status', 'address', 'mls', 'highlight', 'saveRef', 'ref'],
    listings,
    listingCount: listings.length,
    _savedSearchSchema: ['location', 'filters', 'continueUrl', 'continueRef', 'ref'],
    savedSearches,
    savedSearchCount: savedSearches.length
  };

  if (suggestions.length > 0) {
    result._suggestionSchema = ['label', 'ref'];
    result.suggestions = suggestions;
    result.suggestionCount = suggestions.length;
  }

  return result;
}

/**
 * Extract a single listing from a listitem node inside the carousel.
 */
function extractListing(listitemNode, context) {
  const { nodeMap, getRef, getNodeName, getNodeRole, getNodeUrl, findChildrenByRole } = context;

  // Find the link (contains URL to listing)
  const links = findChildrenByRole(listitemNode.nodeId, 'link');
  const listingLink = links.find(l => {
    const url = getNodeUrl(l);
    return url && url.includes('/homedetails/');
  });
  if (!listingLink) return null;

  const url = getNodeUrl(listingLink);
  const listingRef = getRef(listingLink);

  // Find the article inside
  const articles = findChildrenByRole(listitemNode.nodeId, 'article');
  if (articles.length === 0) return null;
  const article = articles[0];

  // Walk all descendants of the article to extract data
  const texts = collectTexts(article.nodeId, context);

  let price = null;
  let beds = null;
  let baths = null;
  let sqft = null;
  let status = null;
  let address = null;
  let mls = null;
  let highlight = null;
  let saveRef = null;

  // Price is the first dollar-prefixed text
  for (const t of texts) {
    if (t.startsWith('$') && !price) {
      price = t;
      break;
    }
  }

  // Beds, baths, sqft - use Abbr nodes to find the numbers before them
  const abbrs = findChildrenByRole(article.nodeId, 'Abbr');
  for (const abbr of abbrs) {
    // Abbr nodes don't have direct names - text is in child StaticText nodes
    const abbrTexts = collectTexts(abbr.nodeId, context);
    const abbrText = abbrTexts.length > 0 ? abbrTexts[0] : '';
    // Walk up to parent listitem to find the number
    const parent = nodeMap.get(abbr.parentId);
    if (parent) {
      const parentTexts = collectTexts(parent.nodeId, context);
      // Find first text that looks like a number
      const numText = parentTexts.find(t => /^\d[\d,]*$/.test(t.trim()));
      if (abbrText === 'bds' && numText) beds = parseInt(numText.replace(/,/g, ''), 10);
      else if (abbrText === 'bd' && numText) beds = parseInt(numText.replace(/,/g, ''), 10);
      else if (abbrText === 'ba' && numText) baths = parseFloat(numText.replace(/,/g, ''));
      else if (abbrText === 'sqft' && numText) sqft = parseInt(numText.replace(/,/g, ''), 10);
    }
  }

  // Status (Active, Pending, etc.)
  for (const t of texts) {
    if (['Active', 'Pending', 'Contingent', 'Coming Soon'].includes(t)) {
      status = t;
      break;
    }
  }

  // Address - try multiple sources
  // First try: group node (text is in child StaticText nodes)
  const groups = findChildrenByRole(article.nodeId, 'group');
  for (const g of groups) {
    const groupTexts = collectTexts(g.nodeId, context);
    const groupText = groupTexts.join(' ');
    if (groupText && groupText.includes(',')) {
      address = groupText;
      break;
    }
  }

  // Second try: link name (often the address link)
  if (!address) {
    for (const link of links) {
      const name = getNodeName(link);
      if (name && name.includes(',') && !name.startsWith('$')) {
        address = name;
        break;
      }
    }
  }

  // MLS info
  for (const t of texts) {
    if (t.startsWith('MLS ID')) {
      mls = t;
      break;
    }
  }

  // Highlight (last misc text like "Large yard", "18 days on Zillow")
  for (const t of texts) {
    if (t !== price && t !== status && t !== address && t !== mls &&
        !t.startsWith('$') && !/^\d+$/.test(t.trim()) &&
        !['bds', 'ba', 'sqft', ' | ', ' '].includes(t.trim()) &&
        t.length > 3 && t.length < 80 &&
        !t.startsWith('MLS')) {
      highlight = t;
    }
  }

  // Save button
  const buttons = findChildrenByRole(article.nodeId, 'button');
  for (const btn of buttons) {
    if (getNodeName(btn) === 'Save') {
      saveRef = getRef(btn);
      break;
    }
  }

  return [url, price, beds, baths, sqft, status, address, mls, highlight, saveRef, listingRef];
}

/**
 * Extract a saved search from a Jump Back In card button.
 */
function extractSavedSearch(buttonNode, context) {
  const { getRef, getNodeUrl, findChildrenByRole } = context;

  const ref = getRef(buttonNode);
  const texts = collectTexts(buttonNode.nodeId, context);

  // Filter out control texts
  const meaningful = texts.filter(t =>
    t !== 'Dismiss' && t !== 'Jump Back In Card' &&
    !t.startsWith('Customize') && !t.startsWith('Find homes') &&
    !t.startsWith('Get real-time') &&
    t.trim().length > 0
  );

  let location = null;
  let filters = null;
  let continueUrl = null;
  let continueRef = null;

  // Location is typically the first meaningful text (e.g., "Fresno, CA")
  if (meaningful.length > 0) location = meaningful[0];
  // Filters is the second (e.g., "For Sale, Max $380k, 2+ beds")
  if (meaningful.length > 1) filters = meaningful[1];

  // Find the "Continue your search" link
  const links = findChildrenByRole(buttonNode.nodeId, 'link');
  for (const link of links) {
    const url = getNodeUrl(link);
    if (url) {
      continueUrl = url;
      continueRef = getRef(link);
      break;
    }
  }

  if (!location && !continueUrl) return null;

  return [location, filters, continueUrl, continueRef, ref];
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
      return; // Don't recurse into InlineTextBox children
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
