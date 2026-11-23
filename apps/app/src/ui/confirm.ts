import { Alert, Platform } from 'react-native';

/** A destructive confirmation: the browser dialog on web, an Alert on native. */
export function confirm(title: string, body: string, action: string, onYes: () => void): void {
  if (Platform.OS === 'web') {
    const ok = (globalThis as { confirm?: (m: string) => boolean }).confirm?.(`${title}\n\n${body}`) ?? true;
    if (ok) onYes();
    return;
  }
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: 'destructive', onPress: onYes },
  ]);
}
