import { describe, expect, it } from 'vitest';
import { messageToLine } from './consolidate.js';
import { withoutExternalLibraryResponses } from './external-library.js';
import { threadMessage } from './session-summary.js';

describe('external library stays outside automatic personal memory', () => {
  it.each(['tool-invocation', 'dynamic-tool', 'tool-call', 'tool-raindrop_read'])(
    'excludes tool result and separate answer (%s), preserves later personal turn',
    (type) => {
      const user = {
        id: '1',
        role: 'user',
        content: 'Cerca in Raindrop',
        createdAt: '2026-11-13T10:00:00Z',
      };
      const personal = {
        id: '5',
        role: 'user',
        content: 'Mio figlio si chiama Giorgio',
        createdAt: '2026-11-13T10:01:00Z',
      };
      const messages = [
        user,
        {
          id: '2',
          role: 'assistant',
          content: {
            parts: [
              { type, toolInvocation: { toolName: 'raindrop_read', result: 'external secret' } },
            ],
          },
        },
        { id: '3', role: 'tool', content: 'external article' },
        {
          id: '4',
          role: 'assistant',
          content: 'Il tuo articolo dice un fatto non tuo',
          createdAt: '2026-11-13T10:00:02Z',
        },
        personal,
        {
          id: '6',
          role: 'assistant',
          content: 'Un altro dettaglio dell’articolo, senza rileggere il tool',
          createdAt: '2026-11-13T10:01:01Z',
        },
      ];
      const safe = withoutExternalLibraryResponses(messages);
      expect(safe).toEqual([user, personal]);
      expect(safe.map(messageToLine).filter(Boolean)).toHaveLength(2);
      expect(safe.map(threadMessage).filter(Boolean)).toHaveLength(2);
    },
  );
  it('does not suppress unrelated tools or an explicit brain write', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolName: 'brain_write' }],
    };
    expect(withoutExternalLibraryResponses([message])).toEqual([message]);
  });
});
