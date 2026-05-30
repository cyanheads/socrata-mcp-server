/**
 * @fileoverview Tests for the explore-open-data prompt.
 * @module tests/prompts/explore-open-data.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { exploreOpenData } from '@/mcp-server/prompts/definitions/explore-open-data.prompt.js';

describe('exploreOpenData prompt', () => {
  it('generates a message for the minimum required input', () => {
    const args = exploreOpenData.args.parse({ topic: 'traffic collisions 2023' });
    const messages = exploreOpenData.generate(args);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content.type).toBe('text');
    const text = messages[0].content.text as string;
    expect(text).toContain('traffic collisions 2023');
    // Should include workflow steps
    expect(text).toContain('socrata_list_portals');
    expect(text).toContain('socrata_find_datasets');
    expect(text).toContain('socrata_get_dataset');
    expect(text).toContain('socrata_query_dataset');
  });

  it('includes the portal domain in the message when provided', () => {
    const args = exploreOpenData.args.parse({
      topic: 'food inspection failures',
      portal: 'data.seattle.gov',
    });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    expect(text).toContain('data.seattle.gov');
    // When portal is known, skip list-portals step
    expect(text).not.toContain('socrata_list_portals');
  });

  it('includes geography scope in the message when provided', () => {
    const args = exploreOpenData.args.parse({
      topic: '311 service requests',
      portal: 'data.cityofnewyork.us',
      geography: 'Brooklyn',
    });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    expect(text).toContain('Brooklyn');
    expect(text).toContain('WHERE');
  });

  it('does not include portal line when portal is omitted', () => {
    const args = exploreOpenData.args.parse({ topic: 'housing permits' });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    // Without a portal, the message should tell the user to discover one first.
    expect(text).toContain('socrata_list_portals');
  });

  it('does not include geography line when geography is omitted', () => {
    const args = exploreOpenData.args.parse({ topic: 'budget spending' });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    // No empty geography line should appear — filtered out.
    expect(text).not.toMatch(/Geography:\s*\n/);
  });

  it('includes aggregation guidance in all generated messages', () => {
    const args = exploreOpenData.args.parse({ topic: 'crime statistics' });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    // Step 5 aggregation section should always be present.
    expect(text).toContain('count(*)');
    expect(text).toContain('group');
  });

  it('handles unicode and special chars in topic without throwing', () => {
    const args = exploreOpenData.args.parse({
      topic: 'café inspections — données 2024',
    });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    expect(text).toContain('café inspections');
  });

  it('does not leak any environment or secret values in the message', () => {
    const args = exploreOpenData.args.parse({ topic: 'test topic' });
    const messages = exploreOpenData.generate(args);
    const text = messages[0].content.text as string;

    // No API token or internal env var patterns should appear.
    expect(text).not.toMatch(/SOCRATA_APP_TOKEN/);
    expect(text).not.toMatch(/process\.env/);
  });
});
