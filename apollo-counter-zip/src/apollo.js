const https = require('https');

// ─── Parse Apollo frontend URL → API payload ──────────────────────────────────
function parseApolloUrl(rawUrl) {
  // Handle hash-based SPA URLs: https://app.apollo.io/#/people?...
  let queryString = '';
  const hashIdx = rawUrl.indexOf('#');
  if (hashIdx !== -1) {
    const afterHash = rawUrl.slice(hashIdx + 1);
    const qIdx = afterHash.indexOf('?');
    if (qIdx !== -1) queryString = afterHash.slice(qIdx + 1);
  } else {
    const qIdx = rawUrl.indexOf('?');
    if (qIdx !== -1) queryString = rawUrl.slice(qIdx + 1);
  }

  if (!queryString) throw new Error('No query parameters found in URL');

  const params = new URLSearchParams(queryString);

  const payload = {
    page: params.get('page') || '1',
    sort_by_field: params.get('sortByField') || '[none]',
    sort_ascending: params.get('sortAscending') === 'true',
    display_mode: 'metadata_mode',
    per_page: 25,
    context: 'people-index-page',
    open_factor_names: [],
    use_pending_signals: false,
    use_cache: false,
    num_fetch_result: 1,
    show_suggestions: false,
    finder_verson: 2,
    search_session_id: generateUuid(),
    ui_finder_random_seed: Math.random().toString(36).substring(2, 10),
    cacheKey: Date.now(),
  };

  const titles = params.getAll('personTitles[]');
  if (titles.length) payload.person_titles = titles;

  const excludedIndustries = params.getAll('organizationNotIndustryTagIds[]');
  if (excludedIndustries.length) payload.organization_not_industry_tag_ids = excludedIndustries;

  const listId = params.get('qOrganizationSearchListId');
  if (listId) payload.q_organization_search_list_id = listId;

  const recConfigId = params.get('recommendationConfigId');
  if (recConfigId) payload.recommendation_config_id = recConfigId;

  // Additional filters
  const personLocations = params.getAll('personLocations[]');
  if (personLocations.length) payload.person_locations = personLocations;

  const orgSizes = params.getAll('organizationNumEmployeesRanges[]');
  if (orgSizes.length) payload.organization_num_employees_ranges = orgSizes;

  const keywords = params.get('qKeywords');
  if (keywords) payload.q_keywords = keywords;

  return payload;
}

// ─── Make the actual Apollo API call ─────────────────────────────────────────
function callApolloApi(payload, cookies, csrfToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    // Build cookie string from Playwright cookie objects
    const cookieStr = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const options = {
      hostname: 'app.apollo.io',
      path: '/api/v1/mixed_people/search_metadata_mode',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://app.apollo.io',
        'Referer': 'https://app.apollo.io/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'x-csrf-token': csrfToken || '',
        'x-referer-host': 'app.apollo.io',
        'x-referer-path': '/people',
        'x-accept-language': 'en',
        'Cookie': cookieStr,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(Object.assign(new Error(`Auth failed: HTTP ${res.statusCode}`), { authError: true }));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Apollo API returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('Failed to parse Apollo response as JSON'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { parseApolloUrl, callApolloApi };
