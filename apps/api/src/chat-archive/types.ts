export interface Archive {
  id: string;
  name: string;
  kind: 'direct' | 'group';
  category: string | null;
  summary: string | null;
  tags: string[];
  messageCount: number;
  participantCount: number;
  firstMessageAt: string | null;
  latestMessageAt: string | null;
  lastImportedAt: string;
  indexedAt: string;
  indexedRevision: number;
  revision: number;
  timeZone: string;
  whatsappPhone: string | null;
  whatsappUrl: string | null;
}
export interface Participant {
  id: string;
  name: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
}
export interface Message {
  id: string;
  senderId: string | null;
  sender: string | null;
  at: string;
  rawText: string;
  text: string;
  type: 'text' | 'system' | 'media';
  position: number;
}
export interface IncomingImport {
  filename: string;
  dataBase64: string;
  timeZone: string;
  archiveId?: string;
  createNew?: boolean;
  name?: string;
  kind?: 'direct' | 'group';
}
export interface Preview {
  name: string;
  kind: 'direct' | 'group';
  parsedCount: number;
  warningCount: number;
  warnings: string[];
  unparsedCount: number;
  firstMessageAt: string | null;
  latestMessageAt: string | null;
  participants: string[];
  candidates: Array<{
    archive: Archive;
    duplicateCount: number;
    newCount: number;
    confidence: number;
  }>;
  suggestedArchiveId: string | null;
}
export interface ImportResult {
  archive: Archive;
  parsedCount: number;
  insertedCount: number;
  duplicateCount: number;
  warningCount: number;
  warnings: string[];
  unparsedCount: number;
}
export interface MessageQuery {
  query?: string;
  senderId?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
  aroundId?: string;
}
export interface ArchivePatch {
  name?: string;
  kind?: 'direct' | 'group';
  category?: string | null;
  summary?: string | null;
  tags?: string[];
  whatsappPhone?: string | null;
  whatsappUrl?: string | null;
}
export interface Retrieval {
  archive: Archive;
  messages: Message[];
  matchedCount: number;
  partial: boolean;
}
export interface ParsedMessage {
  at: string;
  localTimestamp: string;
  sender: string | null;
  senderKey: string | null;
  rawText: string;
  text: string;
  type: Message['type'];
  fingerprint: string;
  position: number;
  rawLineStart: number;
  rawLineEnd: number;
}
export interface ParsedArchive {
  filename: string;
  fileHash: string;
  textHash: string;
  rawText: string;
  name: string;
  kind: 'direct' | 'group';
  timeZone: string;
  messages: ParsedMessage[];
  participants: string[];
  warnings: string[];
  unparsedLines: Array<{ line: number; text: string }>;
}
export interface ChatArchiveRepository {
  preview(userId: string, input: IncomingImport): Promise<Preview>;
  import(userId: string, input: IncomingImport): Promise<ImportResult>;
  list(
    userId: string,
    options?: { query?: string; offset?: number; limit?: number },
  ): Promise<{ archives: Archive[]; total: number }>;
  get(
    userId: string,
    id: string,
  ): Promise<{ archive: Archive; participants: Participant[] } | null>;
  messages(
    userId: string,
    id: string,
    options?: MessageQuery,
  ): Promise<{ messages: Message[]; total: number }>;
  update(userId: string, id: string, patch: ArchivePatch): Promise<Archive | null>;
  remove(userId: string, id: string): Promise<boolean>;
  retrieve(userId: string, id: string, options?: MessageQuery): Promise<Retrieval | null>;
}
export class ChatArchiveError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
