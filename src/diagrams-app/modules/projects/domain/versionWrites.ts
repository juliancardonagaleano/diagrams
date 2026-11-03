export interface RestoreVersionCommand {
  ifUpdatedAt?: string;
  by?: string;
}

export function prepareRestoreVersion(input: RestoreVersionCommand): RestoreVersionCommand {
  return input;
}

export function prepareVersionLabel(label: string): string {
  return label;
}
