import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  APPROVED_SUSTAINABILITY_CATEGORIES,
  COMMON_COLUMN_TITLES,
  DEFAULT_IMAGES_DIRECTORY,
  PUBLISHED_STATUS,
  READY_TO_PUBLISH_STATUS,
  SMARTSHEET_API_BASE,
  ValidationError,
  buildCaseSensitiveImageFilenameSet,
  buildColumnLookup,
  formatDateForWebsite,
  generatePreviewRecords,
  getCellText,
  getDateCellValue,
  requireEnv,
  rowIdentifier,
  trimText
} from "./generate-projects-preview.mjs";

export const PRODUCTION_REPOSITORY = "seqispotlights/se-qi-spotlights";
export const MAIN_BRANCH = "main";
export const PROJECTS_OUTPUT_PATH = "data/projects.json";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const WEBSITE_RECORD_ID_PATTERN = /^SEQI-(\d{4,})$/;
export const DO_NOT_PUBLISH_STATUS = "Do not publish";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);

export class PublishValidationError extends Error {
  constructor(errors) {
    super("Publishing validation failed.");
    this.name = "PublishValidationError";
    this.errors = errors;
  }
}

function getGitHubRefName(env = process.env) {
  return env.GITHUB_REF_NAME || trimText(env.GITHUB_REF).replace(/^refs\/heads\//, "");
}

export function assertProductionPublishGuards({
  repository = process.env.GITHUB_REPOSITORY,
  refName = getGitHubRefName()
} = {}) {
  const errors = [];

  if (repository !== PRODUCTION_REPOSITORY) {
    errors.push(`repository must be ${PRODUCTION_REPOSITORY}`);
  }

  if (refName !== MAIN_BRANCH) {
    errors.push(`branch must be ${MAIN_BRANCH}`);
  }

  if (errors.length > 0) {
    throw new Error(`Publish guard failed: ${errors.join("; ")}.`);
  }
}

export function getVancouverIsoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function toWebsiteDateFromIso(isoDate) {
  return formatDateForWebsite(isoDate);
}

export function parseWebsiteDateToIso(value) {
  const text = trimText(value);
  const match = text.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (!match) return "";

  const monthLookup = new Map(
    Array.from({ length: 12 }, (_, index) => {
      const monthName = new Intl.DateTimeFormat("en-GB", {
        month: "long",
        timeZone: "UTC"
      }).format(new Date(Date.UTC(2026, index, 1)));
      return [monthName.toLowerCase(), String(index + 1).padStart(2, "0")];
    })
  );

  const [, day, monthName, year] = match;
  const month = monthLookup.get(monthName.toLowerCase());
  if (!month) return "";

  return `${year}-${month}-${String(Number(day)).padStart(2, "0")}`;
}

function normalizeDateCellToIso(value) {
  const text = trimText(value);
  if (!text) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().slice(0, 10);
}

function extractImageFilename(record) {
  const photo = trimText(record?.photo);
  if (!photo.startsWith(`${DEFAULT_IMAGES_DIRECTORY}/`)) return "";

  const filename = photo.slice(`${DEFAULT_IMAGES_DIRECTORY}/`.length);
  if (!filename || filename.includes("/") || filename.includes("\\")) return "";

  return filename;
}

export function buildExistingRecordLookups(records) {
  const byId = new Map();
  const imageOwnerByFilename = new Map();

  for (const record of records || []) {
    const id = trimText(record?.id);
    if (!id) continue;

    byId.set(id, record);
    const filename = extractImageFilename(record);
    if (filename) imageOwnerByFilename.set(filename, id);
  }

  return { byId, imageOwnerByFilename };
}

export function sanitizeRecordIdForFilename(recordId) {
  return trimText(recordId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSupportedImageExtension(attachment) {
  const extension = extname(trimText(attachment?.name)).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return "";
  return JPEG_EXTENSIONS.has(extension) ? ".jpg" : extension;
}

function getAttachmentSizeBytes(attachment) {
  if (Number.isFinite(attachment?.sizeInBytes)) return Number(attachment.sizeInBytes);
  if (Number.isFinite(attachment?.size)) return Number(attachment.size);
  if (Number.isFinite(attachment?.sizeInKb)) return Number(attachment.sizeInKb) * 1024;
  return undefined;
}

function describeAttachment(attachment) {
  const parts = [
    trimText(attachment?.name) || "<unnamed>",
    trimText(attachment?.attachmentType),
    trimText(attachment?.mimeType)
  ].filter(Boolean);

  return parts.join(" / ");
}

function unsupportedAttachmentSummary(attachments) {
  if (!attachments?.length) return "no attachments found on row";

  return `attachments on row: ${attachments.map(describeAttachment).join("; ")}`;
}

export function selectSingleSupportedImageAttachment(recordId, attachments) {
  const supported = (attachments || []).filter(attachment =>
    getSupportedImageExtension(attachment)
  );

  if (supported.length === 0) {
    throw new PublishValidationError([
      {
        recordId,
        issue: `Expected exactly one supported image attachment; found 0 (${unsupportedAttachmentSummary(attachments)})`
      }
    ]);
  }

  if (supported.length > 1) {
    throw new PublishValidationError([
      {
        recordId,
        issue: `Expected exactly one supported image attachment; found ${supported.length}`
      }
    ]);
  }

  const [attachment] = supported;
  const sizeBytes = getAttachmentSizeBytes(attachment);
  if (sizeBytes !== undefined && sizeBytes > MAX_IMAGE_BYTES) {
    throw new PublishValidationError([
      {
        recordId,
        issue: "Image attachment exceeds 10 MB"
      }
    ]);
  }

  return attachment;
}

export function generatedImageFilename(recordId, attachment) {
  const stem = sanitizeRecordIdForFilename(recordId);
  const extension = getSupportedImageExtension(attachment);

  if (!stem) {
    throw new PublishValidationError([
      {
        recordId: recordId || "<missing>",
        issue: "Website record ID cannot be converted into an image filename"
      }
    ]);
  }

  if (!extension) {
    throw new PublishValidationError([
      {
        recordId,
        issue: "Unsupported image attachment type"
      }
    ]);
  }

  return `${stem}${extension}`;
}

function buildPublicationDateForRow(
  row,
  columnLookup,
  existingRecord,
  { allowExistingFallback = false } = {}
) {
  const sheetDate = getDateCellValue(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationDate));
  const sheetIso = normalizeDateCellToIso(sheetDate);

  if (sheetDate && !sheetIso) {
    throw new Error("Website publication date is not a recognized date.");
  }

  if (sheetIso) {
    return {
      publishedOn: toWebsiteDateFromIso(sheetIso),
      isoDate: sheetIso,
      source: "smartsheet",
      wasBlankInSmartsheet: false
    };
  }

  const existingPublishedOn = trimText(existingRecord?.publishedOn);
  if (allowExistingFallback && existingPublishedOn) {
    const existingIso = parseWebsiteDateToIso(existingPublishedOn);
    if (!existingIso) {
      throw new Error("Existing website publication date is not a recognized date.");
    }

    return {
      publishedOn: existingPublishedOn,
      isoDate: existingIso,
      source: "existing",
      wasBlankInSmartsheet: true
    };
  }

  throw new Error("Missing required field: Website publication date");
}

async function smartsheetJson(path, accessToken, { method = "GET", body, operation } = {}) {
  const response = await fetch(`${SMARTSHEET_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(
      `${operation || "Smartsheet API request"} failed with HTTP ${response.status} ${response.statusText}.`
    );
  }

  return response.json();
}

async function fetchSheet(sheetId, accessToken) {
  return smartsheetJson(`/sheets/${encodeURIComponent(sheetId)}`, accessToken, {
    operation: "Fetch Smartsheet sheet"
  });
}

async function fetchRowAttachments(sheetId, accessToken, rowId) {
  const result = await smartsheetJson(
    `/sheets/${encodeURIComponent(sheetId)}/rows/${encodeURIComponent(rowId)}/attachments?includeAll=true`,
    accessToken,
    {
      operation: "Fetch row attachments"
    }
  );

  return Array.isArray(result?.data) ? result.data : [];
}

async function fetchAttachmentMetadata(sheetId, accessToken, attachmentId) {
  return smartsheetJson(
    `/sheets/${encodeURIComponent(sheetId)}/attachments/${encodeURIComponent(attachmentId)}`,
    accessToken,
    {
      operation: "Fetch attachment metadata"
    }
  );
}

async function downloadAttachmentBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Attachment download failed with HTTP ${response.status} ${response.statusText}.`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function makeDefaultAttachmentClient(sheetId, accessToken) {
  return {
    async listRowAttachments(row) {
      return fetchRowAttachments(sheetId, accessToken, row.id);
    },
    async getAttachmentMetadata(attachment) {
      return fetchAttachmentMetadata(sheetId, accessToken, attachment.id);
    },
    async downloadAttachment(metadata) {
      if (!metadata?.url) {
        throw new Error("Smartsheet attachment metadata did not include a download URL.");
      }
      return downloadAttachmentBytes(metadata.url);
    }
  };
}

function makeRecordError(recordId, issue) {
  return {
    recordId: recordId || "<missing>",
    issue
  };
}

function getPublicationStatus(row, columnLookup) {
  return getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus));
}

export function countReadyToPublishRows(sheet) {
  const columnLookup = buildColumnLookup(sheet.columns || []);
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  return rows.filter(row => getPublicationStatus(row, columnLookup) === READY_TO_PUBLISH_STATUS)
    .length;
}

function withCellText(row, column, value) {
  let replaced = false;
  const cells = (row.cells || []).map(cell => {
    if (cell.columnId !== column.id) return cell;
    replaced = true;
    return {
      ...cell,
      value,
      displayValue: value
    };
  });

  if (!replaced) {
    cells.push({
      columnId: column.id,
      value,
      displayValue: value
    });
  }

  return {
    ...row,
    cells
  };
}

export function assignMissingReadyRecordIds(
  sheet,
  columnLookup = buildColumnLookup(sheet.columns || [])
) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const recordIdColumn = columnLookup.get(COMMON_COLUMN_TITLES.recordId);
  const errors = [];
  const seenIds = new Map();
  const reservedIds = new Set();
  let highestSequence = 0;

  for (const row of rows) {
    const recordId = getCellText(row, recordIdColumn);
    if (!recordId) continue;

    const normalizedId = recordId.toUpperCase();
    if (seenIds.has(normalizedId)) {
      errors.push(makeRecordError(recordId, "Duplicate Website record ID"));
    } else {
      seenIds.set(normalizedId, row.id);
    }
    reservedIds.add(normalizedId);

    const match = recordId.match(WEBSITE_RECORD_ID_PATTERN);
    if (match) highestSequence = Math.max(highestSequence, Number(match[1]));

    const status = getPublicationStatus(row, columnLookup);
    if (
      (status === READY_TO_PUBLISH_STATUS || status === PUBLISHED_STATUS) &&
      !WEBSITE_RECORD_ID_PATTERN.test(recordId)
    ) {
      errors.push(makeRecordError(recordId, "Website record ID must match SEQI-####"));
    }
  }

  if (errors.length > 0) throw new PublishValidationError(errors);

  const generatedRecordIdByRowId = new Map();
  const effectiveRows = rows.map(row => {
    const status = getPublicationStatus(row, columnLookup);
    const existingRecordId = getCellText(row, recordIdColumn);
    if (status !== READY_TO_PUBLISH_STATUS || existingRecordId) return row;

    if (row.id === undefined || row.id === null) {
      throw new PublishValidationError([
        makeRecordError("<missing>", "Ready row is missing its Smartsheet row ID")
      ]);
    }

    let generatedRecordId;
    do {
      highestSequence += 1;
      generatedRecordId = `SEQI-${String(highestSequence).padStart(4, "0")}`;
    } while (reservedIds.has(generatedRecordId));

    reservedIds.add(generatedRecordId);
    generatedRecordIdByRowId.set(row.id, generatedRecordId);
    return withCellText(row, recordIdColumn, generatedRecordId);
  });

  return {
    sheet: {
      ...sheet,
      rows: effectiveRows
    },
    generatedRecordIdByRowId
  };
}

export function validateGeneratedWebsiteRecords(records) {
  const errors = [];
  const approvedCategories = new Set(APPROVED_SUSTAINABILITY_CATEGORIES);

  function inspectValue(value, recordId, path) {
    if (value === null || value === undefined) {
      errors.push(makeRecordError(recordId, `${path} contains a null or undefined value`));
      return;
    }

    if (typeof value === "number" && !Number.isFinite(value)) {
      errors.push(makeRecordError(recordId, `${path} contains a non-finite number`));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectValue(item, recordId, `${path}[${index}]`));
      return;
    }

    if (typeof value === "object") {
      for (const [key, childValue] of Object.entries(value)) {
        inspectValue(childValue, recordId, `${path}.${key}`);
      }
    }
  }

  for (const record of records || []) {
    const recordId = trimText(record?.id) || "<missing>";
    inspectValue(record, recordId, "record");

    const categories = [
      ...(record?.sustainabilityPrinciples || []),
      ...(record?.sustainabilityOpportunities || []).map(item => item?.name)
    ];
    for (const category of categories) {
      if (!approvedCategories.has(category)) {
        errors.push(makeRecordError(recordId, `Unapproved sustainability category: ${category}`));
      }
    }
  }

  if (errors.length > 0) throw new PublishValidationError(errors);
}

function toValidationErrors(error, fallbackRecordId) {
  if (error instanceof PublishValidationError || error instanceof ValidationError) {
    return error.errors;
  }

  return [makeRecordError(fallbackRecordId, error.message)];
}

async function resolvePhotoFilename({
  row,
  recordId,
  imagesDirectory,
  existingImageFilenames,
  imageOwnerByFilename,
  plannedImageOwners,
  tempDirectory,
  attachmentClient
}) {
  const attachments = await attachmentClient.listRowAttachments(row, recordId);
  const selectedAttachment = selectSingleSupportedImageAttachment(recordId, attachments);
  const filename = generatedImageFilename(recordId, selectedAttachment);
  const existingOwner = imageOwnerByFilename.get(filename);
  const plannedOwner = plannedImageOwners.get(filename);

  if (plannedOwner && plannedOwner !== recordId) {
    throw new PublishValidationError([
      makeRecordError(recordId, `Generated image path already planned for ${plannedOwner}`)
    ]);
  }

  const metadata = await attachmentClient.getAttachmentMetadata(selectedAttachment, recordId);
  const bytes = await attachmentClient.downloadAttachment(metadata, recordId);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new PublishValidationError([makeRecordError(recordId, "Downloaded image exceeds 10 MB")]);
  }

  if (existingImageFilenames.has(filename)) {
    if (existingOwner && existingOwner !== recordId) {
      throw new PublishValidationError([
        makeRecordError(recordId, "Generated image path already belongs to another record")
      ]);
    }

    const existingBytes = await readFile(join(imagesDirectory, filename));
    if (Buffer.compare(existingBytes, bytes) === 0) {
      return {
        filename,
        mode: "reused-generated-existing"
      };
    }
  }

  const tempPath = join(tempDirectory, filename);
  await writeFile(tempPath, bytes);
  plannedImageOwners.set(filename, recordId);

  return {
    filename,
    mode: existingImageFilenames.has(filename) ? "updated" : "downloaded",
    tempPath,
    bytes: bytes.length,
    overwrite: existingImageFilenames.has(filename)
  };
}

export async function buildPublishPlan({
  sheet,
  currentRecords = [],
  imagesDirectory = DEFAULT_IMAGES_DIRECTORY,
  fallbackDate = new Date(),
  tempDirectory,
  attachmentClient
}) {
  const columnLookup = buildColumnLookup(sheet.columns || []);
  const { sheet: effectiveSheet, generatedRecordIdByRowId } = assignMissingReadyRecordIds(
    sheet,
    columnLookup
  );
  const rows = Array.isArray(effectiveSheet.rows) ? effectiveSheet.rows : [];
  const eligibleStatuses = [READY_TO_PUBLISH_STATUS, PUBLISHED_STATUS];
  const readyRows = rows.filter(
    row =>
      getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus)) ===
      READY_TO_PUBLISH_STATUS
  );
  const skippedMissingPublicationDateRows = readyRows
    .map(row => {
      const publicationDate = getDateCellValue(
        row,
        columnLookup.get(COMMON_COLUMN_TITLES.publicationDate)
      );
      if (publicationDate) return undefined;

      return {
        row,
        recordId: rowIdentifier(row, columnLookup),
        rowId: row.id,
        issue: "Website publication date is missing; row was not published."
      };
    })
    .filter(Boolean);
  const skippedReadyRowSet = new Set(skippedMissingPublicationDateRows.map(item => item.row));
  const publishableReadyRows = readyRows.filter(row => !skippedReadyRowSet.has(row));
  const eligibleRows = rows.filter(
    row =>
      eligibleStatuses.includes(
        getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus))
      ) && !skippedReadyRowSet.has(row)
  );
  const doNotPublishRows = rows.filter(
    row => getPublicationStatus(row, columnLookup) === DO_NOT_PUBLISH_STATUS
  );
  const errors = [];

  const seenRecordIds = new Set();
  for (const row of eligibleRows) {
    const recordId = getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.recordId));
    if (!recordId) {
      errors.push(makeRecordError("<missing>", "Missing required field: Website record ID"));
      continue;
    }
    if (seenRecordIds.has(recordId)) {
      errors.push(makeRecordError(recordId, "Duplicate Website record ID"));
    }
    seenRecordIds.add(recordId);
  }

  if (errors.length > 0) {
    throw new PublishValidationError(errors);
  }

  const { byId: existingRecordsById, imageOwnerByFilename } =
    buildExistingRecordLookups(currentRecords);
  const existingImageFilenames = buildCaseSensitiveImageFilenameSet(imagesDirectory);
  const plannedImageOwners = new Map();
  const photoFilenameByRecordId = new Map();
  const publishedOnByRecordId = new Map();
  const downloadedImages = [];
  const reusedImageRecordIds = [];

  for (const row of eligibleRows) {
    const recordId = rowIdentifier(row, columnLookup);
    const existingRecord = existingRecordsById.get(recordId);
    const status = getPublicationStatus(row, columnLookup);

    try {
      const publicationDate = buildPublicationDateForRow(row, columnLookup, existingRecord, {
        allowExistingFallback: status === PUBLISHED_STATUS
      });
      publishedOnByRecordId.set(recordId, publicationDate.publishedOn);

      const photo = await resolvePhotoFilename({
        row,
        recordId,
        imagesDirectory,
        existingImageFilenames,
        imageOwnerByFilename,
        plannedImageOwners,
        tempDirectory,
        attachmentClient
      });

      photoFilenameByRecordId.set(recordId, photo.filename);

      if (photo.mode === "downloaded" || photo.mode === "updated") {
        downloadedImages.push({
          recordId,
          filename: photo.filename,
          tempPath: photo.tempPath,
          bytes: photo.bytes,
          overwrite: photo.overwrite === true
        });
      } else {
        reusedImageRecordIds.push(recordId);
      }
    } catch (error) {
      errors.push(...toValidationErrors(error, recordId));
    }
  }

  if (errors.length > 0) {
    throw new PublishValidationError(errors);
  }

  const finalImageFilenames = new Set([
    ...existingImageFilenames,
    ...downloadedImages.map(image => image.filename)
  ]);

  let generated;
  try {
    generated = generatePreviewRecords(
      {
        ...effectiveSheet,
        rows: rows.filter(row => !skippedReadyRowSet.has(row))
      },
      {
        eligiblePublicationStatuses: eligibleStatuses,
        photoFilenameByRecordId,
        publishedOnByRecordId,
        availableImageFilenames: finalImageFilenames,
        fallbackDate
      }
    );
  } catch (error) {
    throw new PublishValidationError(toValidationErrors(error));
  }

  const records = [
    ...generated.records,
    ...skippedMissingPublicationDateRows
      .map(item => existingRecordsById.get(item.recordId))
      .filter(Boolean)
  ].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, {
      numeric: true,
      sensitivity: "base"
    })
  );

  validateGeneratedWebsiteRecords(records);
  const serialized = `${JSON.stringify(records, null, 2)}\n`;
  JSON.parse(serialized);

  const imagePathErrors = [];
  for (const record of records) {
    const filename = extractImageFilename(record);
    if (!filename || !finalImageFilenames.has(filename)) {
      imagePathErrors.push(makeRecordError(record.id, `Missing image file: ${record.photo}`));
    }
  }

  if (imagePathErrors.length > 0) {
    throw new PublishValidationError(imagePathErrors);
  }

  const statusColumn = columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus);
  const recordIdColumn = columnLookup.get(COMMON_COLUMN_TITLES.recordId);
  const photoFilenameColumn = columnLookup.get(COMMON_COLUMN_TITLES.photoFilename);
  const writeBackRows = eligibleRows
    .map(row => {
      const recordId = rowIdentifier(row, columnLookup);
      if (!photoFilenameByRecordId.has(recordId)) return undefined;
      const status = getPublicationStatus(row, columnLookup);
      const finalPhotoFilename = photoFilenameByRecordId.get(recordId);
      const sourcePhotoFilename = getCellText(
        row,
        columnLookup.get(COMMON_COLUMN_TITLES.photoFilename)
      );
      const shouldMarkPublished = status === READY_TO_PUBLISH_STATUS;
      const shouldWritePhotoFilename =
        shouldMarkPublished || sourcePhotoFilename !== finalPhotoFilename;

      if (
        !shouldMarkPublished &&
        !shouldWritePhotoFilename &&
        !generatedRecordIdByRowId.has(row.id)
      ) {
        return undefined;
      }

      return {
        recordId,
        rowId: row.id,
        recordIdColumnId: recordIdColumn.id,
        statusColumnId: statusColumn.id,
        photoFilenameColumnId: photoFilenameColumn.id,
        markPublished: shouldMarkPublished,
        finalPhotoFilename: shouldWritePhotoFilename ? finalPhotoFilename : undefined,
        recordIdWasBlank: generatedRecordIdByRowId.has(row.id)
      };
    })
    .filter(Boolean);

  return {
    records,
    serialized,
    downloadedImages,
    reusedImageRecordIds,
    writeBackRows,
    publicationAttemptIsoDate: getVancouverIsoDate(fallbackDate),
    summary: {
      totalRowsRead: rows.length,
      eligibleRecordCount: eligibleRows.length,
      readyToPublishCount: publishableReadyRows.length,
      skippedMissingPublicationDateCount: skippedMissingPublicationDateRows.length,
      skippedMissingPublicationDateRows: skippedMissingPublicationDateRows.map(
        ({ recordId, rowId, issue }) => ({ recordId, rowId, issue })
      ),
      publishedCount: eligibleRows.length - publishableReadyRows.length,
      doNotPublishCount: doNotPublishRows.length,
      projectCount: records.filter(record => record.type === "project").length,
      initiativeCount: records.filter(record => record.type === "initiative").length,
      websiteRecordIds: records.map(record => record.id),
      generatedRecordIds: [...generatedRecordIdByRowId.values()],
      downloadedImageCount: downloadedImages.length,
      reusedImageCount: reusedImageRecordIds.length
    }
  };
}

export function buildSmartsheetWriteBackPayload(writeBackRows) {
  return (writeBackRows || []).map(row => {
    const cells = [];

    if (row.markPublished) {
      cells.push({
        columnId: row.statusColumnId,
        value: PUBLISHED_STATUS,
        strict: false
      });
    }

    if (row.finalPhotoFilename) {
      cells.push({
        columnId: row.photoFilenameColumnId,
        value: row.finalPhotoFilename,
        strict: false
      });
    }

    if (row.recordIdWasBlank) {
      cells.push({
        columnId: row.recordIdColumnId,
        value: row.recordId,
        strict: false
      });
    }

    return {
      id: row.rowId,
      cells
    };
  });
}

export function detectNoChange(currentSerialized, plan) {
  return currentSerialized === plan.serialized && plan.downloadedImages.length === 0;
}

export function detectPublicationWork(currentSerialized, plan) {
  const galleryChanged = !detectNoChange(currentSerialized, plan);
  const hasReadyRows = plan.summary.readyToPublishCount > 0;
  const hasWriteBackRows = plan.writeBackRows.length > 0;

  return {
    shouldPublish: hasReadyRows || galleryChanged || hasWriteBackRows,
    galleryChanged,
    hasReadyRows,
    hasWriteBackRows
  };
}

async function applyPublishPlan(plan, metadataPath) {
  const tempJsonPath = join(await mkdtemp(join(tmpdir(), "seqi-publish-json-")), "projects.json");
  await writeFile(tempJsonPath, plan.serialized, "utf8");
  JSON.parse(await readFile(tempJsonPath, "utf8"));

  await mkdir(DEFAULT_IMAGES_DIRECTORY, { recursive: true });
  for (const image of plan.downloadedImages) {
    const targetPath = join(DEFAULT_IMAGES_DIRECTORY, image.filename);
    if (existsSync(targetPath) && !image.overwrite) {
      throw new Error(`Refusing to overwrite existing image path for ${image.recordId}.`);
    }
    await copyFile(image.tempPath, targetPath);
  }

  await mkdir(dirname(PROJECTS_OUTPUT_PATH), { recursive: true });
  await copyFile(tempJsonPath, PROJECTS_OUTPUT_PATH);

  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        publicationAttemptIsoDate: plan.publicationAttemptIsoDate,
        writeBackRows: plan.writeBackRows,
        summary: plan.summary
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

export async function updateSmartsheetRows(sheetId, accessToken, writeBackRows) {
  if (writeBackRows.length === 0) {
    return {
      updatedCount: 0
    };
  }

  const payload = buildSmartsheetWriteBackPayload(writeBackRows);
  const response = await smartsheetJson(
    `/sheets/${encodeURIComponent(sheetId)}/rows`,
    accessToken,
    {
      method: "PUT",
      body: payload,
      operation: "Smartsheet publication write-back"
    }
  );

  const failedItems = response.failedItems || response.result?.failedItems || [];
  const successMessage = !response.message || response.message === "SUCCESS";
  const successCode = response.resultCode === undefined || response.resultCode === 0;
  if (failedItems.length > 0 || !successCode || !successMessage) {
    throw new PublishValidationError(
      writeBackRows.map(row =>
        makeRecordError(row.recordId, "Smartsheet write-back did not fully succeed")
      )
    );
  }

  return {
    updatedCount: writeBackRows.length
  };
}

function logSafeSummary(summary) {
  console.log(`Total Smartsheet rows read: ${summary.totalRowsRead}`);
  console.log(`Eligible record count: ${summary.eligibleRecordCount}`);
  console.log(`Ready-to-publish count: ${summary.readyToPublishCount}`);
  console.log(
    `Skipped missing-publication-date count: ${summary.skippedMissingPublicationDateCount || 0}`
  );
  for (const skippedRow of summary.skippedMissingPublicationDateRows || []) {
    console.log(`Skipped ${skippedRow.recordId}: ${skippedRow.issue}`);
  }
  console.log(`Already-published count: ${summary.publishedCount}`);
  console.log(`Do-not-publish count: ${summary.doNotPublishCount}`);
  console.log(`Project count: ${summary.projectCount}`);
  console.log(`Initiative count: ${summary.initiativeCount}`);
  console.log(`Website record IDs: ${summary.websiteRecordIds.join(", ") || "(none)"}`);
  console.log(`Generated Website record IDs: ${summary.generatedRecordIds.join(", ") || "(none)"}`);
  console.log(`Downloaded-image count: ${summary.downloadedImageCount}`);
  console.log(`Reused-image count: ${summary.reusedImageCount}`);
}

async function writeGitHubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await appendFile(outputPath, `${name}=${value}\n`, "utf8");
}

async function buildCurrentPublicationPlan(sheetId, accessToken) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "seqi-publish-images-"));
  const sheet = await fetchSheet(sheetId, accessToken);
  const currentSerialized = existsSync(PROJECTS_OUTPUT_PATH)
    ? await readFile(PROJECTS_OUTPUT_PATH, "utf8")
    : "[]\n";
  const currentRecords = JSON.parse(currentSerialized);
  const plan = await buildPublishPlan({
    sheet,
    currentRecords,
    tempDirectory,
    attachmentClient: makeDefaultAttachmentClient(sheetId, accessToken)
  });

  return {
    currentSerialized,
    plan
  };
}

async function writePublicationDecisionOutputs(decision, readyCount) {
  await writeGitHubOutput("should_publish", decision.shouldPublish ? "true" : "false");
  await writeGitHubOutput("gallery_changed", decision.galleryChanged ? "true" : "false");
  await writeGitHubOutput("ready_count", String(readyCount));
}

async function runCheck() {
  assertProductionPublishGuards();

  const accessToken = requireEnv("SMARTSHEET_ACCESS_TOKEN");
  const sheetId = requireEnv("SMARTSHEET_SHEET_ID");
  const { currentSerialized, plan } = await buildCurrentPublicationPlan(sheetId, accessToken);
  const decision = detectPublicationWork(currentSerialized, plan);

  logSafeSummary(plan.summary);
  console.log(`Generated gallery changed: ${decision.galleryChanged ? "yes" : "no"}`);
  console.log(`Smartsheet write-back required: ${decision.hasWriteBackRows ? "yes" : "no"}`);
  console.log(
    decision.shouldPublish ? "Publishing is required." : "No publishing work is required."
  );
  await writePublicationDecisionOutputs(decision, plan.summary.readyToPublishCount);
}

function logValidationErrors(errors) {
  console.error("Publishing validation errors:");
  for (const error of errors) {
    console.error(`- ${error.recordId}: ${error.issue}`);
  }
}

async function runPrepare() {
  assertProductionPublishGuards();

  const accessToken = requireEnv("SMARTSHEET_ACCESS_TOKEN");
  const sheetId = requireEnv("SMARTSHEET_SHEET_ID");
  const metadataPath =
    process.env.PUBLISH_METADATA_PATH || join(tmpdir(), "seqi-publish-metadata.json");
  const { currentSerialized, plan } = await buildCurrentPublicationPlan(sheetId, accessToken);
  const decision = detectPublicationWork(currentSerialized, plan);
  await writePublicationDecisionOutputs(decision, plan.summary.readyToPublishCount);

  if (!decision.shouldPublish) {
    logSafeSummary(plan.summary);
    console.log("Generated public gallery is unchanged; skipping publication.");
    return;
  }

  await applyPublishPlan(plan, metadataPath);
  logSafeSummary(plan.summary);
  console.log(`Generated gallery changed: ${decision.galleryChanged ? "yes" : "no"}`);
  console.log(`Smartsheet write-back required: ${decision.hasWriteBackRows ? "yes" : "no"}`);
  console.log(`Prepared Smartsheet write-back count: ${plan.writeBackRows.length}`);
}

async function runWriteBack() {
  assertProductionPublishGuards();

  const accessToken = requireEnv("SMARTSHEET_ACCESS_TOKEN");
  const sheetId = requireEnv("SMARTSHEET_SHEET_ID");
  const metadataPath =
    process.env.PUBLISH_METADATA_PATH || join(tmpdir(), "seqi-publish-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

  const result = await updateSmartsheetRows(sheetId, accessToken, metadata.writeBackRows || []);
  console.log(`Smartsheet update count: ${result.updatedCount}`);
}

async function main() {
  const command = process.argv[2] || "prepare";

  if (command === "check") {
    await runCheck();
    return;
  }

  if (command === "prepare") {
    await runPrepare();
    return;
  }

  if (command === "writeback") {
    await runWriteBack();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => {
    if (error instanceof PublishValidationError || error instanceof ValidationError) {
      logValidationErrors(error.errors);
    } else {
      console.error(`Publishing failed: ${error.message}`);
    }

    process.exitCode = 1;
  });
}
