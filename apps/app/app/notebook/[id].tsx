import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { EditorScreen } from '../../src/editor/EditorScreen';

export default function NotebookRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EditorScreen key={id} notebookId={String(id)} />;
}
