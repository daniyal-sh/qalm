/** Settings → Lecture mode (docs/lecture-mode.md): off by default, account-only, and how transcripts are made. */
import * as React from 'react';
import { View } from 'react-native';

import { useSession } from '../state/session';
import { Button, Segmented, Toggle } from '../ui/controls';
import { Panel, Row } from '../ui/layout';
import { Text } from '../ui/Text';
import { setLecturePrefs, useLecturePrefs } from './prefs';
import { deviceRecognizer, type DeviceRecognizer } from './transcribe';

type Mode = 'device' | 'cloud';

export function LectureSettings() {
  const s = useSession();
  const prefs = useLecturePrefs();
  const signedIn = !!s.user && !!s.tm;
  const [device, setDevice] = React.useState<DeviceRecognizer | null>(null);
  React.useEffect(() => {
    let alive = true;
    void deviceRecognizer(prefs.lang)
      .catch((): DeviceRecognizer => ({ available: false, why: 'The speech recognizer could not start.' }))
      .then((d) => alive && setDevice(d));
    return () => {
      alive = false;
    };
  }, [prefs.lang]);

  return (
    <View style={{ gap: 8 }}>
      <Panel>
        <Row
          title="Lecture mode"
          description={
            signedIn
              ? 'Adds a Record button to the editor: audio, every stroke and a transcript on one timeline. Recordings sync to your devices and count towards your storage (about 20–30 MB an hour).'
              : 'Sign in to record lectures. Recordings are kept in your account.'
          }
          last={!prefs.enabled || !signedIn}
        >
          <Toggle label="Lecture mode" value={prefs.enabled && signedIn} disabled={!signedIn} onChange={(enabled) => void setLecturePrefs({ enabled })} />
        </Row>
        {prefs.enabled && signedIn ? (
          <Row
            title="Transcription"
            description={
              prefs.cloud
                ? 'Cloud transcription (Whisper): each couple of minutes of audio is sent to qalm’s server and transcribed. Up to 600 minutes a month.'
                : device === null
                  ? 'Checking this device…'
                  : device.available
                    ? 'On this device: the audio never leaves it.'
                    : (device.why ?? 'There’s no on-device recognizer here.')
            }
            last
          >
            <Segmented<Mode>
              value={prefs.cloud ? 'cloud' : 'device'}
              onChange={(m) => void setLecturePrefs({ cloud: m === 'cloud' })}
              options={[
                { value: 'device', label: 'On device' },
                { value: 'cloud', label: 'Cloud (Whisper)' },
              ]}
            />
          </Row>
        ) : null}
      </Panel>
      {prefs.enabled && signedIn && !prefs.cloud && device && !device.available ? (
        <Panel>
          <View style={{ padding: 16, gap: 10 }}>
            <Text>Recordings here get no transcript without cloud transcription.</Text>
            <View style={{ flexDirection: 'row' }}>
              <Button label="Use cloud transcription" icon="cloud" onPress={() => void setLecturePrefs({ cloud: true })} />
            </View>
          </View>
        </Panel>
      ) : null}
    </View>
  );
}
