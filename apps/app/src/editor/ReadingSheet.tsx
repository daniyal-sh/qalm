import { LOCAL_ORIGIN, type Page } from '@qalm/core';
import * as React from 'react';
import { View } from 'react-native';

import { Button, Pill, TextField, type PillTone } from '../ui/controls';
import { Sheet } from '../ui/layout';
import { Text } from '../ui/Text';
import { addReading, readingSource, saveReading, selectionReadings, type ReadingTone } from './reading.logic';

const PILL: Record<ReadingTone, PillTone> = { user: 'accent', agent: 'assistant' };

/**
 * What an agent read in the selected ink (or what the student wrote for it): each reading with who it's from and a
 * "stale" badge once the ink changed since. Editing makes a reading the student's own, which agents can't overwrite.
 * With no reading yet, the student can write one.
 */
export function ReadingSheet({ page, ink, onClose, onDone }: { page: Page; ink: string[]; onClose(): void; onDone(msg: string | null): void }) {
  const readings = React.useMemo(() => selectionReadings(page.readings(), page.items(), ink), [page, ink]);
  const [drafts, setDrafts] = React.useState(() => readings.map((r) => r.text));
  const [own, setOwn] = React.useState('');
  const many = readings.length > 1;
  const save = () => {
    let saved = 0;
    let removed = 0;
    // One transaction: one undo step for the whole sheet.
    page.doc.transact(() => {
      if (!readings.length) {
        if (addReading(page, ink, own) === 'saved') saved++;
        return;
      }
      readings.forEach((r, i) => {
        const res = saveReading(page, r, drafts[i] ?? '');
        if (res === 'saved') saved++;
        else if (res === 'removed') removed++;
      });
    }, LOCAL_ORIGIN);
    onDone(saved ? (many ? 'Readings saved' : 'Reading saved') : removed ? 'Reading removed' : null);
  };
  return (
    <Sheet
      visible
      onClose={onClose}
      title="Reading"
      width={520}
      footer={
        <>
          <Button label="Cancel" onPress={onClose} />
          <Button label="Save" variant="primary" onPress={save} />
        </>
      }
    >
      {readings.length ? (
        <Text tone="muted">
          What your agent read in this ink. Fix it if it's wrong: your text is yours, and agents can't change it. Leave it
          empty to remove it.
        </Text>
      ) : (
        <>
          <Text tone="muted">No agent has read this yet. Agents see your handwriting as an image and can save what they read here.</Text>
          <TextField
            value={own}
            onChangeText={setOwn}
            placeholder="Or type what it says"
            accessibilityLabel="Your reading"
            autoFocus
            onSubmitEditing={save}
          />
        </>
      )}
      {readings.map((r, i) => {
        const src = readingSource(r);
        return (
          <View key={r.id} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
              <Pill label={src.label} tone={PILL[src.tone]} />
              {r.stale ? <Pill label="Stale" tone="warn" icon="alert-triangle" /> : null}
            </View>
            <TextField
              value={drafts[i]}
              onChangeText={(t) => setDrafts((d) => d.map((x, k) => (k === i ? t : x)))}
              placeholder="Type what it says"
              accessibilityLabel={many ? `Reading ${i + 1}` : 'Reading'}
              autoFocus={i === 0}
              onSubmitEditing={many ? undefined : save}
            />
            {r.stale ? (
              <Text variant="meta" tone="faint">
                The ink changed since this was read. Agents see it as an image again until it's read again.
              </Text>
            ) : null}
          </View>
        );
      })}
    </Sheet>
  );
}
