export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mimeType: string;
  /** base64 data and a local path are mutually exclusive. */
  data?: string;
  path?: string;
}

export type AudioBlock = {
  type: "audio";
  mimeType: string;
  data: string;
};

export type EmbeddedResourceBlock = {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
};

export type ResourceLinkBlock = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
};

/** Closed content admitted as a user or Plugin prompt Input. */
export type PromptBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | EmbeddedResourceBlock
  | ResourceLinkBlock;
