import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const SMARTSHEET_API_BASE = "https://api.smartsheet.com/2.0";
const PREVIEW_OUTPUT_PATH = "data/projects.preview.json";
export const DEFAULT_IMAGES_DIRECTORY = "images";
export const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;
export const READY_TO_PUBLISH_STATUS = "Ready to publish";
export const PUBLISHED_STATUS = "Published";
export const PROJECT_TOOLKIT_USE = "For a specific project";
export const INITIATIVE_TOOLKIT_USE = "As a training or capacity building tool";
export const APPROVED_SUSTAINABILITY_CATEGORIES = Object.freeze([
  "Prevention",
  "Stewardship / Appropriateness",
  "Mitigation / Decarbonization",
  "Adaptation and Resilience",
  "Clinical Specialties or Treatment Modality"
]);
const WEBSITE_LABEL_OVERRIDES = new Map([
  ["Climate resilience and adaptation", "Adaptation and Resilience"],
  ["Clinical specialty or treatment modality", "Clinical Specialties or Treatment Modality"]
]);
const SUPPORTED_PREVIEW_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif"
]);
const PREVIEW_JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);
const PREVIEW_HEIC_EXTENSIONS = new Set([".heic", ".heif"]);
const execFileAsync = promisify(execFile);

export const EXPECTED_COLUMN_TITLES = [
  "Primary Column",
  "Respondent name",
  "Organization",
  "Department",
  "Contact email",
  "Province/ Territory",
  "Intended toolkit use",
  "Project title",
  "Project description",
  "Project stage",
  "Healthcare setting",
  "Sustainability considered prior to toolkit",
  "Sustainability position after toolkit",
  "Prevention",
  "Prevention - Comments",
  "Stewardship / Appropriateness",
  "Stewardship Comments",
  "Climate resilience and adaptation",
  "Climate resilience and adaptation - Comments",
  "Clinical specialty or treatment modality",
  "Clinical specialty or treatment modality - Comment",
  "Mitigation / Decarbonization",
  "Mitigation / Decarbonization - comments",
  "Activity data",
  "Environmental data",
  "Cost/Savings Data",
  "Efficiency",
  "Efficiency - Comments",
  "Safety",
  "Safety - Comments",
  "Timeliness",
  "Timeliness- Comments",
  "Equity",
  "Equity - Comments",
  "Patient-Centredness / Respect",
  "Patient-Centeredness - Comments",
  "Effectiveness",
  "Effectiveness- Comments",
  "Appropriateness",
  "Appropriateness - Comments",
  "Accessibility",
  "Accessibility - Comments",
  "Other",
  "Other - Comments",
  "Initiative title",
  "Initiative description",
  "Initiative Stage",
  "Toolkit application",
  "Toolkit audience & uptake",
  "Most valuable toolkit elements",
  "Potential for formal QI integration?",
  "QI integration comments",
  "6-Month Follow-Up?",
  "Created By",
  "Created date",
  "Modified By",
  "Modified",
  "Website record ID",
  "Website publication status",
  "Website publication date",
  "Website photo filename"
];

export const COMMON_COLUMN_TITLES = {
  recordId: "Website record ID",
  publicationStatus: "Website publication status",
  publicationDate: "Website publication date",
  photoFilename: "Website photo filename",
  toolkitUse: "Intended toolkit use",
  respondentName: "Respondent name",
  contactEmail: "Contact email",
  organization: "Organization",
  department: "Department",
  province: "Province/ Territory"
};

export const PROJECT_COLUMN_TITLES = {
  title: "Project title",
  description: "Project description",
  stage: "Project stage",
  healthcareSetting: "Healthcare setting",
  mostValuableElements: "Most valuable toolkit elements",
  activityData: "Activity data",
  environmentalData: "Environmental data"
};

export const INITIATIVE_COLUMN_TITLES = {
  title: "Initiative title",
  description: "Initiative description",
  stage: "Initiative Stage",
  toolkitApplication: "Toolkit application",
  toolkitAudienceUptake: "Toolkit audience & uptake",
  mostValuableElements: "Most valuable toolkit elements",
  qiIntegration: "Potential for formal QI integration?",
  qiIntegrationComments: "QI integration comments"
};

const SUSTAINABILITY_PRINCIPLE_COLUMNS = [
  "Prevention",
  "Stewardship / Appropriateness",
  "Mitigation / Decarbonization",
  "Climate resilience and adaptation",
  "Clinical specialty or treatment modality"
];

const OPPORTUNITY_PAIRS = [
  ["Prevention", "Prevention - Comments"],
  ["Stewardship / Appropriateness", "Stewardship Comments"],
  ["Mitigation / Decarbonization", "Mitigation / Decarbonization - comments"],
  ["Climate resilience and adaptation", "Climate resilience and adaptation - Comments"],
  ["Clinical specialty or treatment modality", "Clinical specialty or treatment modality - Comment"]
];

const DOMAIN_PAIRS = [
  ["Efficiency", "Efficiency - Comments"],
  ["Safety", "Safety - Comments"],
  ["Timeliness", "Timeliness- Comments"],
  ["Equity", "Equity - Comments"],
  ["Patient-Centredness / Respect", "Patient-Centeredness - Comments"],
  ["Effectiveness", "Effectiveness- Comments"],
  ["Appropriateness", "Appropriateness - Comments"],
  ["Accessibility", "Accessibility - Comments"],
  ["Other", "Other - Comments"]
];

export class ValidationError extends Error {
  constructor(errors) {
    super("Preview generation validation failed.");
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export function requireEnv(name) {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value.trim();
}

export function trimText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function rowIdentifier(row, columnLookup) {
  return getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.recordId)) || "<missing>";
}

export function buildColumnLookup(columns) {
  const lookup = new Map();
  const duplicateTitles = new Set();

  for (const column of columns || []) {
    const title = trimText(column.title);
    if (!title) continue;

    if (lookup.has(title)) duplicateTitles.add(title);
    lookup.set(title, column);
  }

  if (duplicateTitles.size > 0) {
    throw new Error(
      `Duplicate Smartsheet column title(s) detected: ${[...duplicateTitles].join(", ")}.`
    );
  }

  const missingColumns = EXPECTED_COLUMN_TITLES.filter(title => !lookup.has(title));
  if (missingColumns.length > 0) {
    throw new Error(`Missing expected Smartsheet column(s): ${missingColumns.join(", ")}.`);
  }

  return lookup;
}

export function getCellByColumnId(row, columnId) {
  return (row.cells || []).find(cell => cell.columnId === columnId);
}

export function getCell(row, column) {
  if (!column) return undefined;
  return getCellByColumnId(row, column.id);
}

export function getCellText(row, column) {
  const cell = getCell(row, column);
  if (!cell) return "";

  if (cell.displayValue !== undefined) return trimText(cell.displayValue);
  if (cell.value !== undefined) return trimText(cell.value);
  if (cell.objectValue !== undefined) return trimText(JSON.stringify(cell.objectValue));

  return "";
}

export function getDateCellValue(row, column) {
  const cell = getCell(row, column);
  if (!cell) return "";

  if (cell.value !== undefined) return trimText(cell.value);
  if (cell.displayValue !== undefined) return trimText(cell.displayValue);

  return "";
}

function isClearlyAffirmative(row, column) {
  const cell = getCell(row, column);
  if (!cell) return false;

  if (cell.value === true || cell.checked === true) return true;

  const textCandidates = [cell.displayValue, cell.value, cell.objectValue?.value]
    .map(trimText)
    .filter(Boolean);

  return textCandidates.some(value => {
    const normalized = value.toLowerCase();
    return (
      normalized.startsWith("yes") ||
      normalized === "true" ||
      normalized === "checked" ||
      normalized === "selected" ||
      normalized === "1"
    );
  });
}

function uniqueTrimmed(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const trimmed = trimText(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function toWebsiteLabel(value) {
  const trimmed = trimText(value);
  return WEBSITE_LABEL_OVERRIDES.get(trimmed) || trimmed;
}

function uniqueWebsiteLabels(values) {
  return uniqueTrimmed(values.map(toWebsiteLabel));
}

function parseDelimitedValues(value) {
  const text = trimText(value);
  if (!text) return [];

  return uniqueTrimmed(text.split(/\r?\n|[;,|]/));
}

function getMultiSelectValues(row, column) {
  const cell = getCell(row, column);
  if (!cell) return [];

  if (Array.isArray(cell.objectValue?.values)) {
    return uniqueWebsiteLabels(cell.objectValue.values);
  }

  if (Array.isArray(cell.value)) {
    return uniqueWebsiteLabels(cell.value);
  }

  if (Array.isArray(cell.displayValue)) {
    return uniqueWebsiteLabels(cell.displayValue);
  }

  return uniqueWebsiteLabels(
    parseDelimitedValues(cell.displayValue ?? cell.value ?? cell.objectValue?.value)
  );
}

function stripBulletPrefix(value) {
  return trimText(value)
    .replace(/^(\s*[-*•‣◦▪●]|\s*\d+[\.)])\s+/, "")
    .trim();
}

function splitListField(value) {
  const text = trimText(value);
  if (!text) return [];

  if (/\r?\n/.test(text)) {
    return text.split(/\r?\n/).map(stripBulletPrefix).filter(Boolean);
  }

  return [stripBulletPrefix(text)].filter(Boolean);
}

export function formatDateForWebsite(value, fallbackDate = new Date()) {
  const text = trimText(value);
  if (!text) {
    throw new Error("Website publication date is missing.");
  }

  const source = text;
  let date;

  if (source instanceof Date) {
    date = source;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    date = new Date(`${source}T00:00:00Z`);
  } else {
    date = new Date(source);
  }

  if (Number.isNaN(date.getTime())) {
    throw new Error("Website publication date is not a recognized date.");
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

export function getRecordType(value) {
  const toolkitUse = trimText(value);

  if (toolkitUse === PROJECT_TOOLKIT_USE) return "project";
  if (toolkitUse === INITIATIVE_TOOLKIT_USE) return "initiative";

  return undefined;
}

function pushMissingError(errors, recordId, fieldName) {
  errors.push({
    recordId,
    issue: `Missing required field: ${fieldName}`
  });
}

function buildDetailPairs(row, columnLookup, pairs) {
  return pairs
    .filter(([checkboxTitle]) => isClearlyAffirmative(row, columnLookup.get(checkboxTitle)))
    .map(([checkboxTitle, commentsTitle]) => ({
      name: toWebsiteLabel(checkboxTitle),
      explanation: cleanOpportunityComment(getCellText(row, columnLookup.get(commentsTitle)))
    }));
}

function cleanOpportunityComment(value) {
  return trimText(value)
    .replace(/(^|[\r\n]+|[.!?;]\s+)[A-Z][A-Za-z /&-]{1,48}:\s*/g, "$1")
    .trim();
}

function buildSelectedLabels(row, columnLookup, columnTitles) {
  return columnTitles
    .filter(columnTitle => isClearlyAffirmative(row, columnLookup.get(columnTitle)))
    .map(toWebsiteLabel);
}

function getFinalPhotoFilename(row, columnLookup, options = {}) {
  const recordId = rowIdentifier(row, columnLookup);
  return (
    options.photoFilenameByRecordId?.get(recordId) ||
    getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.photoFilename))
  );
}

function buildCommonRecord(row, columnLookup, recordType, title, fallbackDate, options = {}) {
  const recordId = getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.recordId));
  const filename = getFinalPhotoFilename(row, columnLookup, options);
  const publishedOn =
    options.publishedOnByRecordId?.get(recordId) ||
    formatDateForWebsite(
      getDateCellValue(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationDate)),
      fallbackDate
    );

  return {
    id: recordId,
    type: recordType,
    title,
    photo: `images/${filename}`,
    photoAlt: title,
    province: getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.province)),
    publishedOn,
    contactName: getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.respondentName)),
    email: getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.contactEmail)),
    organization: getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.organization)),
    department: getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.department))
  };
}

function mapProjectRow(row, columnLookup, fallbackDate, options = {}) {
  const title = getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.title));
  const common = buildCommonRecord(row, columnLookup, "project", title, fallbackDate, options);

  return {
    ...common,
    stage: getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.stage)),
    healthcareSetting: getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.healthcareSetting)),
    description: getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.description)),
    cobenefit: getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.mostValuableElements)),
    sustainabilityPrinciples: buildSelectedLabels(
      row,
      columnLookup,
      SUSTAINABILITY_PRINCIPLE_COLUMNS
    ),
    sustainabilityOpportunities: buildDetailPairs(row, columnLookup, OPPORTUNITY_PAIRS),
    metrics: {
      environmental: splitListField(
        getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.environmentalData))
      ),
      activity: splitListField(
        getCellText(row, columnLookup.get(PROJECT_COLUMN_TITLES.activityData))
      )
    },
    domainsOfQuality: buildDetailPairs(row, columnLookup, DOMAIN_PAIRS)
  };
}

function mapInitiativeRow(row, columnLookup, fallbackDate, options = {}) {
  const title = getCellText(row, columnLookup.get(INITIATIVE_COLUMN_TITLES.title));
  const common = buildCommonRecord(row, columnLookup, "initiative", title, fallbackDate, options);
  const stage = getCellText(row, columnLookup.get(INITIATIVE_COLUMN_TITLES.stage));

  return {
    ...common,
    stage,
    healthcareSetting: "",
    description: getCellText(row, columnLookup.get(INITIATIVE_COLUMN_TITLES.description)),
    sustainabilityPrinciples: [],
    sustainabilityOpportunities: [],
    metrics: {
      environmental: [],
      activity: []
    },
    domainsOfQuality: [],
    cobenefit: "",
    initiativeStage: stage,
    toolkitApplication: getCellText(
      row,
      columnLookup.get(INITIATIVE_COLUMN_TITLES.toolkitApplication)
    ),
    toolkitAudienceUptake: getCellText(
      row,
      columnLookup.get(INITIATIVE_COLUMN_TITLES.toolkitAudienceUptake)
    ),
    mostValuableElements: getCellText(
      row,
      columnLookup.get(INITIATIVE_COLUMN_TITLES.mostValuableElements)
    ),
    qiIntegration: getCellText(row, columnLookup.get(INITIATIVE_COLUMN_TITLES.qiIntegration)),
    qiIntegrationComments: getCellText(
      row,
      columnLookup.get(INITIATIVE_COLUMN_TITLES.qiIntegrationComments)
    )
  };
}

function validateCommonRequiredFields(row, columnLookup, errors, options = {}) {
  const recordId = rowIdentifier(row, columnLookup);
  const missingChecks = [
    [COMMON_COLUMN_TITLES.recordId, "Website record ID"],
    [COMMON_COLUMN_TITLES.toolkitUse, "Intended toolkit use"],
    [COMMON_COLUMN_TITLES.organization, "Organization"]
  ];

  for (const [columnTitle, fieldName] of missingChecks) {
    if (!getCellText(row, columnLookup.get(columnTitle))) {
      pushMissingError(errors, recordId, fieldName);
    }
  }

  if (!getFinalPhotoFilename(row, columnLookup, options)) {
    pushMissingError(errors, recordId, "Website photo filename");
  }
}

function validateTypeRequiredFields(row, columnLookup, recordType, errors) {
  const recordId = rowIdentifier(row, columnLookup);
  const missingChecks = [];

  if (recordType === "project") {
    missingChecks.push(
      [PROJECT_COLUMN_TITLES.title, "Project title"],
      [PROJECT_COLUMN_TITLES.description, "Project description"],
      [PROJECT_COLUMN_TITLES.stage, "Project stage"]
    );
  } else if (recordType === "initiative") {
    missingChecks.push(
      [INITIATIVE_COLUMN_TITLES.title, "Initiative title"],
      [INITIATIVE_COLUMN_TITLES.description, "Initiative description"],
      [INITIATIVE_COLUMN_TITLES.stage, "Initiative Stage"]
    );
  }

  for (const [columnTitle, fieldName] of missingChecks) {
    if (!getCellText(row, columnLookup.get(columnTitle))) {
      pushMissingError(errors, recordId, fieldName);
    }
  }
}

export function buildCaseSensitiveImageFilenameSet(imagesDirectory = DEFAULT_IMAGES_DIRECTORY) {
  return new Set(
    readdirSync(imagesDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
  );
}

function getSupportedPreviewImageExtension(attachment) {
  const extension = extname(trimText(attachment?.name)).toLowerCase();
  if (!SUPPORTED_PREVIEW_IMAGE_EXTENSIONS.has(extension)) return "";
  if (PREVIEW_HEIC_EXTENSIONS.has(extension)) return ".jpg";
  return PREVIEW_JPEG_EXTENSIONS.has(extension) ? ".jpg" : extension;
}

function requiresPreviewJpegConversion(attachment) {
  return PREVIEW_HEIC_EXTENSIONS.has(extname(trimText(attachment?.name)).toLowerCase());
}

async function convertPreviewHeicAttachmentToJpeg({
  recordId,
  attachment,
  sourceBytes,
  tempDirectory
}) {
  const sourceExtension = extname(trimText(attachment?.name)).toLowerCase() || ".heic";
  const stem = trimText(recordId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const sourcePath = join(tempDirectory, `${stem}-source${sourceExtension}`);
  const outputPath = join(tempDirectory, `${stem}-converted.jpg`);

  await writeFile(sourcePath, sourceBytes);

  try {
    await execFileAsync(process.env.HEIF_CONVERT_BIN || "heif-convert", [sourcePath, outputPath], {
      windowsHide: true
    });
  } catch (error) {
    const detail = trimText(error?.stderr) || trimText(error?.message);
    throw new Error(
      `HEIC/HEIF image conversion failed for ${recordId}. Ensure heif-convert is installed before publishing.${detail ? ` ${detail}` : ""}`
    );
  }

  return readFile(outputPath);
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

export function selectSinglePreviewImageAttachment(recordId, attachments) {
  const supported = (attachments || []).filter(attachment =>
    getSupportedPreviewImageExtension(attachment)
  );

  if (supported.length === 0) {
    throw new ValidationError([
      {
        recordId,
        issue: `Expected exactly one supported image attachment; found 0 (${unsupportedAttachmentSummary(attachments)})`
      }
    ]);
  }

  if (supported.length > 1) {
    throw new ValidationError([
      {
        recordId,
        issue: `Expected exactly one supported image attachment; found ${supported.length}`
      }
    ]);
  }

  const [attachment] = supported;
  const sizeBytes = getAttachmentSizeBytes(attachment);
  if (sizeBytes !== undefined && sizeBytes > MAX_PREVIEW_IMAGE_BYTES) {
    throw new ValidationError([
      {
        recordId,
        issue: "Image attachment exceeds 10 MB"
      }
    ]);
  }

  return attachment;
}

export function generatedPreviewImageFilename(recordId, attachment) {
  const stem = trimText(recordId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const extension = getSupportedPreviewImageExtension(attachment);

  if (!stem) {
    throw new ValidationError([
      {
        recordId: recordId || "<missing>",
        issue: "Website record ID cannot be converted into an image filename"
      }
    ]);
  }

  if (!extension) {
    throw new ValidationError([
      {
        recordId,
        issue: "Unsupported image attachment type"
      }
    ]);
  }

  return `${stem}${extension}`;
}

function previewValidationErrors(error, recordId) {
  if (error instanceof ValidationError) return error.errors;
  return [
    {
      recordId: recordId || "<missing>",
      issue: error.message
    }
  ];
}

export async function generatePreviewWithAttachments(sheet, options = {}) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const columnLookup = buildColumnLookup(sheet.columns || []);
  const eligiblePublicationStatuses = options.eligiblePublicationStatuses || [
    READY_TO_PUBLISH_STATUS
  ];
  const approvedRows = rows.filter(row =>
    eligiblePublicationStatuses.includes(
      getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus))
    )
  );
  const imagesDirectory = options.imagesDirectory || DEFAULT_IMAGES_DIRECTORY;
  const imageConverter = options.imageConverter || convertPreviewHeicAttachmentToJpeg;
  const tempDirectory =
    options.tempDirectory || (await mkdtemp(join(tmpdir(), "seqi-preview-images-")));
  const photoFilenameByRecordId = new Map();
  const downloadedImages = [];
  const errors = [];

  await mkdir(imagesDirectory, { recursive: true });
  const availableImageFilenames = buildCaseSensitiveImageFilenameSet(imagesDirectory);

  for (const row of approvedRows) {
    const recordId = rowIdentifier(row, columnLookup);

    try {
      if (!options.attachmentClient) {
        throw new Error("Preview attachment client is required");
      }

      const attachments = await options.attachmentClient.listRowAttachments(row, recordId);
      const selectedAttachment = selectSinglePreviewImageAttachment(recordId, attachments);
      const filename = generatedPreviewImageFilename(recordId, selectedAttachment);
      const metadata = await options.attachmentClient.getAttachmentMetadata(
        selectedAttachment,
        recordId
      );
      let bytes = await options.attachmentClient.downloadAttachment(metadata, recordId);
      if (bytes.length > MAX_PREVIEW_IMAGE_BYTES) {
        throw new ValidationError([
          {
            recordId,
            issue: "Downloaded image exceeds 10 MB"
          }
        ]);
      }

      if (requiresPreviewJpegConversion(selectedAttachment)) {
        bytes = Buffer.from(
          await imageConverter({
            recordId,
            attachment: selectedAttachment,
            sourceBytes: bytes,
            tempDirectory
          })
        );

        if (bytes.length > MAX_PREVIEW_IMAGE_BYTES) {
          throw new ValidationError([
            {
              recordId,
              issue: "Converted JPEG image exceeds 10 MB"
            }
          ]);
        }
      }

      const imagePath = join(imagesDirectory, filename);
      const shouldWriteImage =
        !availableImageFilenames.has(filename) ||
        Buffer.compare(await readFile(imagePath), bytes) !== 0;
      if (shouldWriteImage) {
        await writeFile(join(imagesDirectory, filename), bytes);
        availableImageFilenames.add(filename);
        downloadedImages.push({
          recordId,
          filename,
          bytes: bytes.length
        });
      }

      photoFilenameByRecordId.set(recordId, filename);
    } catch (error) {
      errors.push(...previewValidationErrors(error, recordId));
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);

  const generated = generatePreviewRecords(sheet, {
    ...options,
    eligiblePublicationStatuses,
    photoFilenameByRecordId,
    availableImageFilenames
  });

  return {
    ...generated,
    downloadedImages
  };
}

function validateImageFile(row, columnLookup, availableImageFilenames, errors, options = {}) {
  const recordId = rowIdentifier(row, columnLookup);
  const filename = getFinalPhotoFilename(row, columnLookup, options);
  if (!filename) return;

  const imagePath = `${DEFAULT_IMAGES_DIRECTORY}/${filename}`;
  if (filename.includes("/") || filename.includes("\\") || !availableImageFilenames.has(filename)) {
    errors.push({
      recordId,
      issue: `Missing image file: ${imagePath}`
    });
  }
}

export function findDuplicateRecordIds(rows, columnLookup) {
  const seen = new Set();
  const duplicates = new Set();

  for (const row of rows) {
    const recordId = getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.recordId));
    if (!recordId) continue;
    if (seen.has(recordId)) duplicates.add(recordId);
    seen.add(recordId);
  }

  return [...duplicates].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function generatePreviewRecords(sheet, options = {}) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const columnLookup = buildColumnLookup(sheet.columns || []);
  const fallbackDate = options.fallbackDate || new Date();
  const eligiblePublicationStatuses = options.eligiblePublicationStatuses || [
    READY_TO_PUBLISH_STATUS
  ];
  const availableImageFilenames =
    options.availableImageFilenames || buildCaseSensitiveImageFilenameSet(options.imagesDirectory);
  const errors = [];

  const readyRows = rows.filter(
    row =>
      getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus)) ===
      READY_TO_PUBLISH_STATUS
  );
  const publishedRows = rows.filter(
    row =>
      getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus)) ===
      PUBLISHED_STATUS
  );

  const approvedRows = rows.filter(row =>
    eligiblePublicationStatuses.includes(
      getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.publicationStatus))
    )
  );

  const duplicateRecordIds = findDuplicateRecordIds(approvedRows, columnLookup);
  for (const recordId of duplicateRecordIds) {
    errors.push({
      recordId,
      issue: "Duplicate Website record ID"
    });
  }

  const records = [];
  for (const row of approvedRows) {
    const recordId = rowIdentifier(row, columnLookup);
    const toolkitUse = getCellText(row, columnLookup.get(COMMON_COLUMN_TITLES.toolkitUse));
    const recordType = getRecordType(toolkitUse);

    validateCommonRequiredFields(row, columnLookup, errors, options);
    validateImageFile(row, columnLookup, availableImageFilenames, errors, options);

    if (!recordType) {
      errors.push({
        recordId,
        issue: "Unknown Intended toolkit use"
      });
      continue;
    }

    validateTypeRequiredFields(row, columnLookup, recordType, errors);

    try {
      records.push(
        recordType === "project"
          ? mapProjectRow(row, columnLookup, fallbackDate, options)
          : mapInitiativeRow(row, columnLookup, fallbackDate, options)
      );
    } catch (error) {
      errors.push({
        recordId,
        issue: error.message
      });
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  records.sort((a, b) =>
    a.id.localeCompare(b.id, undefined, {
      numeric: true,
      sensitivity: "base"
    })
  );

  return {
    records,
    summary: {
      totalRowsRead: rows.length,
      readyToPublishRowCount: readyRows.length,
      publishedRowCount: publishedRows.length,
      eligibleRowCount: approvedRows.length,
      publicPermissionApprovedRowCount: approvedRows.length,
      generatedProjectCount: records.filter(record => record.type === "project").length,
      generatedInitiativeCount: records.filter(record => record.type === "initiative").length,
      generatedWebsiteRecordIds: records.map(record => record.id)
    }
  };
}

async function fetchSheet(sheetId, accessToken) {
  const response = await fetch(`${SMARTSHEET_API_BASE}/sheets/${encodeURIComponent(sheetId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Smartsheet API request failed with HTTP ${response.status} ${response.statusText}.`
    );
  }

  return response.json();
}

async function fetchSmartsheetJson(path, accessToken, operation) {
  const response = await fetch(`${SMARTSHEET_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

function makePreviewAttachmentClient(sheetId, accessToken) {
  return {
    async listRowAttachments(row) {
      const response = await fetchSmartsheetJson(
        `/sheets/${encodeURIComponent(sheetId)}/rows/${encodeURIComponent(row.id)}/attachments?includeAll=true`,
        accessToken,
        "Fetch row attachments"
      );
      return Array.isArray(response?.data) ? response.data : [];
    },
    async getAttachmentMetadata(attachment) {
      return fetchSmartsheetJson(
        `/sheets/${encodeURIComponent(sheetId)}/attachments/${encodeURIComponent(attachment.id)}`,
        accessToken,
        "Fetch attachment metadata"
      );
    },
    async downloadAttachment(metadata) {
      if (!metadata?.url) {
        throw new Error("Smartsheet attachment metadata did not include a download URL.");
      }

      const response = await fetch(metadata.url);
      if (!response.ok) {
        throw new Error(
          `Attachment download failed with HTTP ${response.status} ${response.statusText}.`
        );
      }

      return Buffer.from(await response.arrayBuffer());
    }
  };
}

function logSafeSummary(summary) {
  console.log("Smartsheet API connection succeeded.");
  console.log(`Total Smartsheet rows read: ${summary.totalRowsRead}`);
  console.log(`Ready-to-publish row count: ${summary.readyToPublishRowCount}`);
  console.log(`Public-permission-approved row count: ${summary.publicPermissionApprovedRowCount}`);
  console.log(`Generated project count: ${summary.generatedProjectCount}`);
  console.log(`Generated initiative count: ${summary.generatedInitiativeCount}`);
  console.log(
    `Generated Website record IDs: ${summary.generatedWebsiteRecordIds.join(", ") || "(none)"}`
  );
  console.log(`Downloaded preview image count: ${summary.downloadedPreviewImageCount || 0}`);
  console.log(`Preview file location: ${PREVIEW_OUTPUT_PATH}`);
}

function logValidationErrors(errors) {
  console.error("Validation errors:");
  for (const error of errors) {
    console.error(`- ${error.recordId}: ${error.issue}`);
  }
}

async function main() {
  const accessToken = requireEnv("SMARTSHEET_ACCESS_TOKEN");
  const sheetId = requireEnv("SMARTSHEET_SHEET_ID");
  const sheet = await fetchSheet(sheetId, accessToken);
  const { records, summary, downloadedImages } = await generatePreviewWithAttachments(sheet, {
    attachmentClient: makePreviewAttachmentClient(sheetId, accessToken)
  });
  const serialized = `${JSON.stringify(records, null, 2)}\n`;

  JSON.parse(serialized);

  await mkdir(dirname(PREVIEW_OUTPUT_PATH), { recursive: true });
  await writeFile(PREVIEW_OUTPUT_PATH, serialized, "utf8");
  logSafeSummary({
    ...summary,
    downloadedPreviewImageCount: downloadedImages.length
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => {
    if (error instanceof ValidationError) {
      logValidationErrors(error.errors);
    } else {
      console.error(`Preview generation failed: ${error.message}`);
    }

    process.exitCode = 1;
  });
}
