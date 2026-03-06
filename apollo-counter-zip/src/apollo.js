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

  // ─── Base payload (matches exact shape from real curl requests) ───────────────
  const payload = {
    sort_by_field: params.get('sortByField') || '[none]',
    sort_ascending: params.get('sortAscending') === 'true',
    page: parseInt(params.get('page') || '1', 10),
    display_mode: 'metadata_mode',
    per_page: 30,
    context: 'people-index-page',
    open_factor_names: [],
    use_pending_signals: false,
    use_cache: false,
    num_fetch_result: 5,
    show_suggestions: false,
    finder_verson: 2,
    search_session_id: generateUuid(),
    ui_finder_random_seed: Math.random().toString(36).substring(2, 13),
    cacheKey: Date.now(),
  };

  // ─── Person title filters ─────────────────────────────────────────────────────
  // Confirmed from real curls: plain string array e.g. ["owner","founder","ceo"]
  const titles = params.getAll('personTitles[]');
  if (titles.length) payload.person_titles = titles;

  const notTitles = params.getAll('personNotTitles[]');
  if (notTitles.length) payload.person_not_titles = notTitles;

  // ─── Person seniority ─────────────────────────────────────────────────────────
  const seniorities = params.getAll('personSeniorities[]');
  if (seniorities.length) payload.person_seniorities = seniorities;

  // ─── Person location filters ──────────────────────────────────────────────────
  const personLocations = params.getAll('personLocations[]');
  if (personLocations.length) payload.person_locations = personLocations;

  const personNotLocations = params.getAll('personNotLocations[]');
  if (personNotLocations.length) payload.person_not_locations = personNotLocations;

  // ─── Contact email filters ────────────────────────────────────────────────────
  const emailStatuses = params.getAll('contactEmailStatusV2[]');
  if (emailStatuses.length) payload.contact_email_status_v2 = emailStatuses;

  const excludeCatchAll = params.get('contactEmailExcludeCatchAll');
  if (excludeCatchAll !== null) payload.contact_email_exclude_catch_all = excludeCatchAll === 'true';

  // ─── Phone filter ─────────────────────────────────────────────────────────────
  const phoneExists = params.get('phoneExists');
  if (phoneExists !== null) payload.phone_exists = phoneExists === 'true';

  // ─── Organization size ────────────────────────────────────────────────────────
  const orgSizes = params.getAll('organizationNumEmployeesRanges[]');
  if (orgSizes.length) payload.organization_num_employees_ranges = orgSizes;

  // ─── Organization location filters ───────────────────────────────────────────
  const orgLocations = params.getAll('organizationLocations[]');
  if (orgLocations.length) payload.organization_locations = orgLocations;

  const orgNotLocations = params.getAll('organizationNotLocations[]');
  if (orgNotLocations.length) payload.organization_not_locations = orgNotLocations;

  // ─── Organization industry filters ───────────────────────────────────────────
  const orgIndustryTagIds = params.getAll('organizationIndustryTagIds[]');
  if (orgIndustryTagIds.length) payload.organization_industry_tag_ids = orgIndustryTagIds;

  const orgNotIndustryTagIds = params.getAll('organizationNotIndustryTagIds[]');
  if (orgNotIndustryTagIds.length) payload.organization_not_industry_tag_ids = orgNotIndustryTagIds;

  // ─── Organization keyword tag filters ────────────────────────────────────────
  // included_organization_keyword_fields: where keyword tags are searched (tags/name/social_media_description)
  const includedOrgKeywordFields = params.getAll('includedOrganizationKeywordFields[]');
  if (includedOrgKeywordFields.length) payload.included_organization_keyword_fields = includedOrgKeywordFields;

  // excluded_organization_keyword_fields: where NOT keyword tags are searched
  const excludedOrgKeywordFields = params.getAll('excludedOrganizationKeywordFields[]');
  if (excludedOrgKeywordFields.length) payload.excluded_organization_keyword_fields = excludedOrgKeywordFields;

  // q_organization_keyword_tags: include tags (merge qOrganizationKeywordTags[] + legacy organizationKeywordTags[])
  const qOrgKeywordTags = params.getAll('qOrganizationKeywordTags[]');
  const legacyOrgKeywordTags = params.getAll('organizationKeywordTags[]');
  const allIncludedTags = [...qOrgKeywordTags, ...legacyOrgKeywordTags];
  if (allIncludedTags.length) payload.q_organization_keyword_tags = allIncludedTags;

  // q_not_organization_keyword_tags: exclude tags
  const qNotOrgKeywordTags = params.getAll('qNotOrganizationKeywordTags[]');
  if (qNotOrgKeywordTags.length) payload.q_not_organization_keyword_tags = qNotOrgKeywordTags;

  // ─── Search list filters ──────────────────────────────────────────────────────
  const listId = params.get('qOrganizationSearchListId');
  if (listId) payload.q_organization_search_list_id = listId;

  const notListId = params.get('qNotOrganizationSearchListId');
  if (notListId) payload.q_not_organization_search_list_id = notListId;

  // ─── Keywords ────────────────────────────────────────────────────────────────
  const keywords = params.get('qKeywords');
  if (keywords) payload.q_keywords = keywords;

  // ─── Recommendation config ────────────────────────────────────────────────────
  // "score" is a valid value — passed through as-is
  const recConfigId = params.get('recommendationConfigId');
  if (recConfigId) payload.recommendation_config_id = recConfigId;

  // ─── Finder view / table layout (seen in real curls with finder_view_id) ──────
  const finderViewId = params.get('finderViewId');
  if (finderViewId) payload.finder_view_id = finderViewId;

  const finderTableLayoutId = params.get('finderTableLayoutId');
  if (finderTableLayoutId) payload.finder_table_layout_id = finderTableLayoutId;

  // ─── Saved search unique URL ──────────────────────────────────────────────────
  const uniqueUrlId = params.get('uniqueUrlId');
  if (uniqueUrlId) payload.unique_url_id = uniqueUrlId;

  // ─── Include similar titles toggle ───────────────────────────────────────────
  const includeSimilarTitles = params.get('includeSimilarTitles');
  if (includeSimilarTitles !== null) payload.include_similar_titles = includeSimilarTitles === 'true';

  // ─── Prospected by current team ──────────────────────────────────────────────
  const prospectedByCurrentTeam = params.getAll('prospectedByCurrentTeam[]');
  if (prospectedByCurrentTeam.length) payload.prospected_by_current_team = prospectedByCurrentTeam;

  // ─── Market segments ─────────────────────────────────────────────────────────
  const marketSegments = params.getAll('marketSegments[]');
  if (marketSegments.length) payload.market_segments = marketSegments;

  // ─── Revenue range ───────────────────────────────────────────────────────────
  const revenueRange = params.getAll('revenueRange[]');
  if (revenueRange.length) payload.revenue_range = revenueRange;

  // ─── Technology filters ───────────────────────────────────────────────────────
  const techUids = params.getAll('currentlyUsingAnyOfTechnologyUids[]');
  if (techUids.length) payload.currently_using_any_of_technology_uids = techUids;

  return payload;
}

// ─── Make the actual Apollo API call ─────────────────────────────────────────
function callApolloApi(payload, cookies, csrfToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

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
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Origin': 'https://app.apollo.io',
        'Referer': 'https://app.apollo.io/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
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
          resolve(JSON.parse(data));
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
