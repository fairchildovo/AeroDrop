import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFileType } from './fileType.ts';

test('maps approved common extensions to semantic file types', () => {
  assert.equal(resolveFileType({ fileName: 'setup.EXE' }), 'executable');
  assert.equal(resolveFileType({ fileName: 'report.xlsx' }), 'spreadsheet');
  assert.equal(resolveFileType({ fileName: 'slides.pptx' }), 'presentation');
  assert.equal(resolveFileType({ fileName: 'photo.webp' }), 'image');
  assert.equal(resolveFileType({ fileName: 'clip.mkv' }), 'video');
  assert.equal(resolveFileType({ fileName: 'intro.flac' }), 'audio');
  assert.equal(resolveFileType({ fileName: 'bundle.7z' }), 'archive');
  assert.equal(resolveFileType({ fileName: 'main.tsx' }), 'code');
  assert.equal(resolveFileType({ fileName: 'metadata.json' }), 'json');
  assert.equal(resolveFileType({ fileName: 'README.md' }), 'document');
});

test('falls back to mime types when the file extension is missing', () => {
  assert.equal(resolveFileType({ fileName: 'preview', mimeType: 'image/png' }), 'image');
  assert.equal(resolveFileType({ fileName: 'recording', mimeType: 'video/mp4' }), 'video');
  assert.equal(resolveFileType({ fileName: 'track', mimeType: 'audio/mpeg' }), 'audio');
  assert.equal(resolveFileType({ fileName: 'notes', mimeType: 'text/plain' }), 'document');
  assert.equal(resolveFileType({ fileName: 'data', mimeType: 'application/json' }), 'json');
});

test('prefers folder and unknown fallbacks correctly', () => {
  assert.equal(resolveFileType({ fileName: 'marketing-assets', isDirectory: true }), 'folder');
  assert.equal(resolveFileType({ fileName: 'unknown.custom' }), 'unknown');
  assert.equal(resolveFileType({ fileName: '' }), 'unknown');
});
