import { LOCAL_ORIGIN, type Line, type Page } from '@qalm/core';
import * as React from 'react';
import { View } from 'react-native';

import { Button, Pill, TextField, type PillTone } from '../ui/controls';
import { Sheet } from '../ui/layout';
import { Text } from '../ui/Text';
import { readingSource, resetReading, saveReading, type ReadingTone } from './reading.logic';

const PILL: Record<ReadingTone, PillTone> = { user: 'accent', agent: 'assistant', device: 'neutral', none: 'neutral' };

/**
 * See and edit what the selected lines say: the saved reading and where it came from (the device's guess, an agent's
 * transcription, or the student's own text). Saving makes it the student's text, which agents can't overwrite.
 */
export function ReadingSheet({ page, lines, onClose, onDone }: { page: Page; lines: Line[]; onClose(): void; onDone(msg: string | null): void }) {
  const [drafts, setDrafts] = React.useState(() => lines.map((l) => l.text ?? ''));
  const many = lines.length > 1;
  const save = () => {
    let saved = 0;
    let cleared = 0;
    // One transaction: one undo step for the whole sheet.
    page.doc.transact(() => {
      lines.forEach((l, i) => {
        const r = saveReading(page, l, drafts[i] ?? '');
        if (r === 'saved') saved++;
        else if (r === 'cleared') cleared++;
      });
    }, LOCAL_ORIGIN);
    onDone(saved ? (many ? 'Readings saved' : 'Reading saved') : cleared ? 'Back to automatic' : null);
  };
  return (
    <Sheet
      visible
      onClose={onClose}
      title={many ? 'Readings' : 'Reading'}
      width={520}
      footer={
        <>
          <Button label="Cancel" onPress={onClose} />
          <Button label="Save" variant="primary" onPress={save} />
        </>
      }
    >
      <Text tone="muted">
        {many ? 'What these lines say' : 'What this line says'}, as your agents see it. Text you type is yours: agents
        can’t change it. Leave it empty to go back to automatic.
      </Text>
      {lines.map((l, i) => {
        const src = readingSource(l);
        return (
          <View key={l.key} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
              {many ? (
                <Text variant="meta" tone="faint">
                  Line {i + 1}
                </Text>
              ) : null}
              <Pill label={src.label} tone={PILL[src.tone]} />
              <View style={{ flex: 1 }} />
              {l.textSrc === 'user' ? (
                <Button
                  label="Use automatic"
                  size="sm"
                  variant="ghost"
                  icon="rotate-ccw"
                  onPress={() => {
                    resetReading(page, l);
                    onDone('Back to automatic');
                  }}
                />
              ) : null}
            </View>
            <TextField
              value={drafts[i]}
              onChangeText={(t) => setDrafts((d) => d.map((x, k) => (k === i ? t : x)))}
              placeholder="Type what this line says"
              accessibilityLabel={many ? `Reading of line ${i + 1}` : 'Reading'}
              autoFocus={i === 0}
              onSubmitEditing={many ? undefined : save}
            />
            {src.tone === 'none' ? (
              <Text variant="meta" tone="faint">
                Connected agents read it from the image until it has a reading.
              </Text>
            ) : null}
          </View>
        );
      })}
    </Sheet>
  );
}
