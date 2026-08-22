/**
 * @fileoverview Tests for the explore-open-data prompt.
 * @module tests/prompts/explore-open-data.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { exploreOpenData } from '@/mcp-server/prompts/definitions/explore-open-data.prompt.js';

async function generatePromptText(input: {
  topic: string;
  portal?: string;
  geography?: string;
}): Promise<string> {
  const args = exploreOpenData.args!.parse(input);
  const messages = await exploreOpenData.generate(args);
  const message = messages[0];
  if (message?.content.type !== 'text') throw new Error('Expected a text prompt message.');
  return message.content.text;
}

describe('exploreOpenData prompt', () => {
  it('generates a message for the minimum required input', async () => {
    const text = await generatePromptText({ topic: 'traffic collisions 2023' });
    expect(text).toContain('traffic collisions 2023');
    // Should include workflow steps
    expect(text).toContain('socrata_list_portals');
    expect(text).toContain('socrata_find_datasets');
    expect(text).toContain('socrata_get_dataset');
    expect(text).toContain('socrata_query_dataset');
  });

  it('includes the portal domain in the message when provided', async () => {
    const text = await generatePromptText({
      topic: 'food inspection failures',
      portal: 'data.seattle.gov',
    });

    expect(text).toContain('data.seattle.gov');
    // When portal is known, skip list-portals step
    expect(text).not.toContain('socrata_list_portals');
  });

  it('includes geography scope in the message when provided', async () => {
    const text = await generatePromptText({
      topic: '311 service requests',
      portal: 'data.cityofnewyork.us',
      geography: 'Brooklyn',
    });

    expect(text).toContain('Brooklyn');
    expect(text).toContain('WHERE');
  });

  it('does not include portal line when portal is omitted', async () => {
    const text = await generatePromptText({ topic: 'housing permits' });

    // Without a portal, the message should tell the user to discover one first.
    expect(text).toContain('socrata_list_portals');
  });

  it('does not include geography line when geography is omitted', async () => {
    const text = await generatePromptText({ topic: 'budget spending' });

    // No empty geography line should appear — filtered out.
    expect(text).not.toMatch(/Geography:\s*\n/);
  });

  it('includes aggregation guidance in all generated messages', async () => {
    const text = await generatePromptText({ topic: 'crime statistics' });

    // Step 5 aggregation section should always be present.
    expect(text).toContain('count(*)');
    expect(text).toContain('group');
  });

  it('handles unicode and special chars in topic without throwing', async () => {
    const text = await generatePromptText({
      topic: 'café inspections — données 2024',
    });

    expect(text).toContain('café inspections');
  });

  it('does not leak any environment or secret values in the message', async () => {
    const text = await generatePromptText({ topic: 'test topic' });

    // No API token or internal env var patterns should appear.
    expect(text).not.toMatch(/SOCRATA_APP_TOKEN/);
    expect(text).not.toMatch(/process\.env/);
  });
});
