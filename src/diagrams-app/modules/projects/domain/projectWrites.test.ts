import { ProjectError } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { prepareCreateProject, prepareRenameProject } from './projectWrites';

describe('prepareCreateProject', () => {
  it('rechaza nombre vacío', () => {
    expect(() => prepareCreateProject({ name: '   ' })).toThrow(ProjectError);
  });
});

describe('prepareRenameProject', () => {
  it('rechaza nombre vacío', () => {
    expect(() => prepareRenameProject('')).toThrow(ProjectError);
  });
});
