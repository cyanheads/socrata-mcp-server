/**
 * @fileoverview Structured workflow prompt for civic data investigation.
 * Guides discovery, schema inspection, querying, and synthesis.
 * @module mcp-server/prompts/definitions/explore-open-data.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const exploreOpenData = prompt('explore_open_data', {
  description:
    'Structured workflow for investigating a civic data question. Guides: discover relevant datasets on the right portal, inspect schemas, query for baseline data, group/aggregate for trends, and synthesize findings with data-freshness caveats.',
  args: z.object({
    topic: z
      .string()
      .describe(
        'Civic data topic or question to investigate (e.g. "traffic collisions in 2023", "food inspection failures", "311 service requests by neighborhood").',
      ),
    portal: z
      .string()
      .optional()
      .describe(
        'Target portal domain if known (e.g. data.seattle.gov). Omit to use socrata_list_portals to find the right portal first.',
      ),
    geography: z
      .string()
      .optional()
      .describe(
        'Geographic scope to focus on (e.g. "Seattle", "King County", "New York City"). Used to scope WHERE clauses.',
      ),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: [
          `I want to investigate: **${args.topic}**`,
          args.portal ? `Portal: ${args.portal}` : '',
          args.geography ? `Geography: ${args.geography}` : '',
          '',
          'Please follow this workflow:',
          '',
          '**Step 1 — Find the right portal**',
          args.portal
            ? `Use domain \`${args.portal}\` directly.`
            : 'Use `socrata_list_portals` to identify the most relevant government portal for this topic.',
          '',
          '**Step 2 — Discover datasets**',
          `Use \`socrata_find_datasets\` with relevant keywords${args.portal ? ` scoped to \`${args.portal}\`` : ''}. Look for datasets that directly address the topic. Note the dataset_id and domain for each candidate.`,
          '',
          '**Step 3 — Inspect schema before querying**',
          'For the most promising dataset, call `socrata_get_dataset` to get the full column schema. Pay attention to:',
          '- Column names and data types (determines WHERE clause quoting)',
          '- Row count (signals dataset size)',
          '- Last updated timestamp (freshness)',
          '- Number vs Text column types (Number → bare literals, Text → single-quoted strings)',
          '',
          '**Step 4 — Query for baseline data**',
          'Use `socrata_query_dataset` to fetch relevant rows. Start with a focused query:',
          args.geography
            ? `- Add a WHERE clause to scope to ${args.geography} if a location column is available`
            : '',
          '- Use select to pick only needed columns',
          '- Set a reasonable limit (100–500) to explore',
          '- The assembled_query field shows the SoQL used',
          '',
          '**Step 5 — Aggregate for trends**',
          'Run a follow-up query with `select` + `group` to find distributions and patterns. Examples:',
          '- Count by category: `select="category, count(*) as n"` + `group="category"` + `order="n DESC"`',
          '- Sum by year: `select="year, sum(amount) as total"` + `group="year"`',
          '',
          '**Step 6 — Synthesize findings**',
          'Present findings with:',
          '- Key numbers and trends from the data',
          '- Data freshness (last updated date from the schema)',
          '- Any caveats about data completeness or SODA 2.1 string typing',
          '- Suggested follow-up queries if the data warrants deeper investigation',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    },
  ],
});
