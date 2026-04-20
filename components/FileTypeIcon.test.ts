import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileTypeIcon } from './FileTypeIcon.tsx';

test('renders semantic lucide icon per file type', () => {
  const spreadsheetMarkup = renderToStaticMarkup(
    React.createElement(FileTypeIcon, { type: 'spreadsheet' }),
  );
  assert.match(spreadsheetMarkup, /lucide-sheet/);

  const executableMarkup = renderToStaticMarkup(
    React.createElement(FileTypeIcon, { type: 'executable' }),
  );
  assert.match(executableMarkup, /lucide-file-cog/);

  const unknownMarkup = renderToStaticMarkup(
    React.createElement(FileTypeIcon, { type: 'unknown' }),
  );
  assert.match(unknownMarkup, /lucide-file/);
});