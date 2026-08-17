import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMMON_COLUMN_TITLES,
  EXPECTED_COLUMN_TITLES,
  INITIATIVE_TOOLKIT_USE,
  PROJECT_TOOLKIT_USE,
  PUBLISHED_STATUS,
  READY_TO_PUBLISH_STATUS,
  ValidationError,
  generatePreviewWithAttachments,
  generatePreviewRecords
} from "./generate-projects-preview.mjs";
import {
  DO_NOT_PUBLISH_STATUS,
  MAX_IMAGE_BYTES,
  MAIN_BRANCH,
  PRODUCTION_REPOSITORY,
  PublishValidationError,
  assertProductionPublishGuards,
  assignMissingReadyRecordIds,
  buildPublishPlan,
  buildSmartsheetWriteBackPayload,
  countReadyToPublishRows,
  detectNoChange,
  detectPublicationWork,
  generatedImageFilename,
  updateSmartsheetRows,
  validateGeneratedWebsiteRecords
} from "./publish-spotlights.mjs";

const columns = EXPECTED_COLUMN_TITLES.map((title, index) => ({
  id: index + 1,
  title
}));
const columnIdByTitle = new Map(columns.map(column => [column.title, column.id]));

function cell(title, value) {
  const cellValue =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : { value, displayValue: value };

  return {
    columnId: columnIdByTitle.get(title),
    ...cellValue
  };
}

function projectRow(overrides = {}) {
  const values = {
    [COMMON_COLUMN_TITLES.recordId]: overrides.recordId ?? "SEQI-0001",
    [COMMON_COLUMN_TITLES.publicationStatus]: overrides.status || READY_TO_PUBLISH_STATUS,
    [COMMON_COLUMN_TITLES.publicationDate]: overrides.publicationDate ?? "2026-07-14",
    [COMMON_COLUMN_TITLES.photoFilename]: overrides.photoFilename ?? "existing.jpg",
    [COMMON_COLUMN_TITLES.toolkitUse]: PROJECT_TOOLKIT_USE,
    [COMMON_COLUMN_TITLES.respondentName]: "Synthetic Respondent",
    [COMMON_COLUMN_TITLES.contactEmail]: "synthetic@example.test",
    [COMMON_COLUMN_TITLES.organization]: overrides.organization || "Synthetic Organization",
    [COMMON_COLUMN_TITLES.department]: "Synthetic Department",
    [COMMON_COLUMN_TITLES.province]: "British Columbia",
    "Project title": overrides.title || "Synthetic Project",
    "Project description": overrides.description || "Synthetic description",
    "Project stage": overrides.stage || "Work in progress",
    "Healthcare setting": "Synthetic setting",
    "Most valuable toolkit elements": "Synthetic toolkit elements",
    Prevention: true,
    "Prevention - Comments": "Synthetic prevention opportunity"
  };

  for (const [key, value] of Object.entries(overrides.cells || {})) {
    values[key] = value;
  }

  return {
    id: overrides.rowId || Number(String(overrides.recordId ?? "1").replace(/\D/g, "")) || 1,
    cells: Object.entries(values).map(([title, value]) => cell(title, value))
  };
}

function initiativeRow(overrides = {}) {
  const values = {
    [COMMON_COLUMN_TITLES.recordId]: overrides.recordId ?? "SEQI-0100",
    [COMMON_COLUMN_TITLES.publicationStatus]: overrides.status || READY_TO_PUBLISH_STATUS,
    [COMMON_COLUMN_TITLES.publicationDate]: overrides.publicationDate ?? "2026-07-14",
    [COMMON_COLUMN_TITLES.photoFilename]: overrides.photoFilename ?? "initiative.jpg",
    [COMMON_COLUMN_TITLES.toolkitUse]: INITIATIVE_TOOLKIT_USE,
    [COMMON_COLUMN_TITLES.respondentName]: "Synthetic Respondent",
    [COMMON_COLUMN_TITLES.contactEmail]: "synthetic@example.test",
    [COMMON_COLUMN_TITLES.organization]: "Synthetic Organization",
    [COMMON_COLUMN_TITLES.department]: "Synthetic Department",
    [COMMON_COLUMN_TITLES.province]: "Ontario",
    "Initiative title": overrides.title || "Synthetic Initiative",
    "Initiative description": overrides.description || "Synthetic initiative description",
    "Initiative Stage": overrides.stage || "Complete",
    "Toolkit application": "Synthetic application",
    "Toolkit audience & uptake": "Synthetic audience",
    "Most valuable toolkit elements": "Synthetic elements",
    "Potential for formal QI integration?": "Yes",
    "QI integration comments": "Synthetic QI comments"
  };

  return {
    id: overrides.rowId || 100,
    cells: Object.entries(values).map(([title, value]) => cell(title, value))
  };
}

function sheet(rows) {
  return {
    columns,
    rows
  };
}

function rowValue(row, title) {
  return row.cells.find(item => item.columnId === columnIdByTitle.get(title))?.value;
}

async function tempImages(filenames = []) {
  const directory = await mkdtemp(join(tmpdir(), "seqi-test-images-"));
  await mkdir(directory, { recursive: true });

  for (const filename of filenames) {
    await writeFile(join(directory, filename), "synthetic image bytes");
  }

  return directory;
}

function attachmentClientForRecordIds(recordIds, bytes = Buffer.from("synthetic image bytes")) {
  return attachmentClientFor(
    new Map(
      recordIds.map((recordId, index) => [
        recordId,
        [
          {
            id: index + 1,
            name: `${recordId.toLowerCase()}-source.jpg`,
            sizeInBytes: bytes.length
          }
        ]
      ])
    ),
    bytes
  );
}

function attachmentClientFor(attachmentsByRecordId, bytes = Buffer.from("synthetic image bytes")) {
  return {
    async listRowAttachments(_row, recordId) {
      return attachmentsByRecordId.get(recordId) || [];
    },
    async getAttachmentMetadata(attachment) {
      return {
        id: attachment.id,
        url: "synthetic://download"
      };
    },
    async downloadAttachment() {
      return bytes;
    }
  };
}

function forbiddenAttachmentClient() {
  return {
    async listRowAttachments() {
      throw new Error("Attachment lookup should not have been called.");
    },
    async getAttachmentMetadata() {
      throw new Error("Attachment metadata should not have been called.");
    },
    async downloadAttachment() {
      throw new Error("Attachment download should not have been called.");
    }
  };
}

async function expectPublishValidation(testName, fn, expectedText) {
  let caught;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }

  assert(caught instanceof PublishValidationError, `${testName}: expected PublishValidationError`);
  assert(
    JSON.stringify(caught.errors).includes(expectedText),
    `${testName}: expected error containing ${expectedText}`
  );
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function buildUnpublishScenario() {
  const imagesDirectory = await tempImages(["seqi-0050.jpg", "seqi-0051.jpg"]);
  const attachmentClient = attachmentClientForRecordIds(["SEQI-0050", "SEQI-0051"]);
  const originalSheet = sheet([
    projectRow({
      recordId: "SEQI-0050",
      rowId: 50,
      status: PUBLISHED_STATUS,
      photoFilename: "published-a.jpg",
      publicationDate: "2026-06-10",
      title: "Published A"
    }),
    projectRow({
      recordId: "SEQI-0051",
      rowId: 51,
      status: PUBLISHED_STATUS,
      photoFilename: "published-b.jpg",
      publicationDate: "2026-06-11",
      title: "Published B"
    })
  ]);
  const originalPlan = await buildPublishPlan({
    sheet: originalSheet,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient
  });
  const unpublishedRow = projectRow({
    recordId: "SEQI-0050",
    rowId: 50,
    status: DO_NOT_PUBLISH_STATUS,
    photoFilename: "published-a.jpg",
    publicationDate: "2026-06-10",
    title: "Published A"
  });
  const sourceRowSnapshot = structuredClone(unpublishedRow);
  const updatedSheet = sheet([
    unpublishedRow,
    projectRow({
      recordId: "SEQI-0051",
      rowId: 51,
      status: PUBLISHED_STATUS,
      photoFilename: "seqi-0051.jpg",
      publicationDate: "2026-06-11",
      title: "Published B"
    })
  ]);
  const unpublishPlan = await buildPublishPlan({
    sheet: updatedSheet,
    currentRecords: originalPlan.records,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient
  });

  return {
    imagesDirectory,
    originalPlan,
    unpublishedRow,
    sourceRowSnapshot,
    unpublishPlan
  };
}

test("Phase 2B mapping validates ID, type, title, description, stage, organization, and photo", async () => {
  const imagesDirectory = await tempImages(["existing.jpg"]);
  const result = generatePreviewRecords(sheet([projectRow()]), {
    imagesDirectory
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "SEQI-0001");
  assert.equal(result.records[0].type, "project");
  assert.equal(result.records[0].title, "Synthetic Project");
  assert.equal(result.records[0].description, "Synthetic description");
  assert.equal(result.records[0].stage, "Work in progress");
  assert.equal(result.records[0].organization, "Synthetic Organization");
  assert.equal(result.records[0].photo, "images/existing.jpg");
  assert.deepEqual(result.records[0].sustainabilityPrinciples, ["Prevention"]);
  assert.deepEqual(result.records[0].sustainabilityOpportunities, [
    {
      name: "Prevention",
      explanation: "Synthetic prevention opportunity"
    }
  ]);
});

test("Phase 2B maps all five sustainability fields to current public labels", async () => {
  const imagesDirectory = await tempImages(["existing.jpg"]);
  const result = generatePreviewRecords(
    sheet([
      projectRow({
        cells: {
          "Stewardship / Appropriateness": true,
          "Stewardship Comments": "Synthetic stewardship opportunity",
          "Mitigation / Decarbonization": true,
          "Mitigation / Decarbonization - comments":
            "Category note: Synthetic mitigation opportunity",
          "Climate resilience and adaptation": true,
          "Climate resilience and adaptation - Comments": "",
          "Clinical specialty or treatment modality": true,
          "Clinical specialty or treatment modality - Comment": "Synthetic clinical opportunity"
        }
      })
    ]),
    { imagesDirectory }
  );

  assert.deepEqual(result.records[0].sustainabilityPrinciples, [
    "Prevention",
    "Stewardship / Appropriateness",
    "Mitigation / Decarbonization",
    "Adaptation and Resilience",
    "Clinical Specialties or Treatment Modality"
  ]);
  assert.deepEqual(
    result.records[0].sustainabilityOpportunities.map(opportunity => opportunity.name),
    [
      "Prevention",
      "Stewardship / Appropriateness",
      "Mitigation / Decarbonization",
      "Adaptation and Resilience",
      "Clinical Specialties or Treatment Modality"
    ]
  );
  assert.equal(
    result.records[0].sustainabilityOpportunities[2].explanation,
    "Synthetic mitigation opportunity"
  );
  assert.equal(result.records[0].sustainabilityOpportunities[3].explanation, "");
});

test("Phase 2B default preview includes Ready to publish only", async () => {
  const imagesDirectory = await tempImages(["existing.jpg", "published.jpg"]);
  const result = generatePreviewRecords(
    sheet([
      projectRow({ recordId: "SEQI-0001", photoFilename: "existing.jpg" }),
      projectRow({
        recordId: "SEQI-0002",
        status: PUBLISHED_STATUS,
        photoFilename: "published.jpg"
      })
    ]),
    { imagesDirectory }
  );
  assert.deepEqual(
    result.records.map(record => record.id),
    ["SEQI-0001"]
  );
});

test("Phase 2B blank publication date is not auto-filled", async () => {
  const imagesDirectory = await tempImages(["existing.jpg"]);
  assert.throws(
    () =>
      generatePreviewRecords(sheet([projectRow({ publicationDate: "" })]), {
        imagesDirectory,
        fallbackDate: new Date("2026-07-15T06:30:00Z")
      }),
    error =>
      error instanceof ValidationError &&
      JSON.stringify(error.errors).includes("Website publication date is missing")
  );
});

test("Phase 2B image validation accepts existing case-sensitive filename", async () => {
  const imagesDirectory = await tempImages(["case.jpg"]);
  const result = generatePreviewRecords(sheet([projectRow({ photoFilename: "case.jpg" })]), {
    imagesDirectory
  });
  assert.equal(result.records[0].photo, "images/case.jpg");
});

test("Phase 2B image validation fails missing filename", async () => {
  const imagesDirectory = await tempImages([]);
  assert.throws(
    () =>
      generatePreviewRecords(sheet([projectRow({ photoFilename: "missing.jpg" })]), {
        imagesDirectory
      }),
    ValidationError
  );
});

test("Phase 2B image validation is case-sensitive", async () => {
  const imagesDirectory = await tempImages(["case.jpg"]);
  assert.throws(
    () =>
      generatePreviewRecords(sheet([projectRow({ photoFilename: "Case.JPG" })]), {
        imagesDirectory
      }),
    ValidationError
  );
});

test("Preview uses a canonical row-attachment filename even when Smartsheet has a legacy filename", async () => {
  const imagesDirectory = await tempImages(["seqi-0001.jpg"]);
  const result = await generatePreviewWithAttachments(
    sheet([projectRow({ photoFilename: "existing.jpg" })]),
    {
      imagesDirectory,
      attachmentClient: attachmentClientForRecordIds(["SEQI-0001"])
    }
  );
  assert.equal(result.records[0].photo, "images/seqi-0001.jpg");
  assert.equal(result.downloadedImages.length, 0);
});

test("Preview resolves and downloads an image attachment when photo filename is blank", async () => {
  const imagesDirectory = await tempImages([]);
  const sourceRow = projectRow({
    recordId: "SEQI-0017",
    rowId: 17,
    photoFilename: ""
  });
  const attachments = new Map([
    [
      "SEQI-0017",
      [
        {
          id: 170,
          name: "spotlight-photo.jpeg",
          sizeInBytes: 1024
        }
      ]
    ]
  ]);
  const result = await generatePreviewWithAttachments(sheet([sourceRow]), {
    imagesDirectory,
    attachmentClient: attachmentClientFor(attachments)
  });

  assert.equal(result.records[0].photo, "images/seqi-0017.jpg");
  assert.deepEqual(
    result.downloadedImages.map(image => image.filename),
    ["seqi-0017.jpg"]
  );
  assert.equal(
    await readFile(join(imagesDirectory, "seqi-0017.jpg"), "utf8"),
    "synthetic image bytes"
  );
  assert.equal(
    sourceRow.cells.find(
      item => item.columnId === columnIdByTitle.get(COMMON_COLUMN_TITLES.photoFilename)
    ).value,
    ""
  );
});

test("Preview fails when neither a photo filename nor valid image attachment exists", async () => {
  const imagesDirectory = await tempImages([]);
  await assert.rejects(
    () =>
      generatePreviewWithAttachments(
        sheet([projectRow({ recordId: "SEQI-0018", photoFilename: "" })]),
        {
          imagesDirectory,
          attachmentClient: attachmentClientFor(
            new Map([
              [
                "SEQI-0018",
                [
                  {
                    id: 180,
                    name: "notes.pdf",
                    sizeInBytes: 1024
                  }
                ]
              ]
            ])
          )
        }
      ),
    ValidationError
  );
});

test("Phase 3 includes Ready and Published, excludes other statuses", async () => {
  const imagesDirectory = await tempImages(["seqi-0001.jpg", "seqi-0002.jpg", "draft.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0001",
        status: READY_TO_PUBLISH_STATUS,
        photoFilename: "ready.jpg"
      }),
      projectRow({
        recordId: "SEQI-0002",
        status: PUBLISHED_STATUS,
        photoFilename: "published.jpg"
      }),
      projectRow({
        recordId: "SEQI-0003",
        status: "Draft",
        photoFilename: "draft.jpg"
      })
    ]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0001", "SEQI-0002"])
  });
  assert.deepEqual(
    plan.records.map(record => record.id),
    ["SEQI-0001", "SEQI-0002"]
  );
  assert.deepEqual(
    plan.records.map(record => record.photo),
    ["images/seqi-0001.jpg", "images/seqi-0002.jpg"]
  );
});

test("Published to Do not publish removes exactly one record and preserves other Published records", async () => {
  const { originalPlan, unpublishPlan } = await buildUnpublishScenario();
  assert.equal(originalPlan.records.length, 2);
  assert.deepEqual(
    unpublishPlan.records.map(record => record.id),
    ["SEQI-0051"]
  );
  assert.equal(unpublishPlan.summary.publishedCount, 1);
  assert.equal(unpublishPlan.summary.doNotPublishCount, 1);
  assert.deepEqual(detectPublicationWork(originalPlan.serialized, unpublishPlan), {
    shouldPublish: true,
    galleryChanged: true,
    hasReadyRows: false,
    hasWriteBackRows: false
  });
});

test("Unpublish generation creates no duplicate public records", async () => {
  const { unpublishPlan } = await buildUnpublishScenario();
  const ids = unpublishPlan.records.map(record => record.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("Unpublish preserves Smartsheet ID, date, photo filename, status, and repository image", async () => {
  const { imagesDirectory, unpublishedRow, sourceRowSnapshot, unpublishPlan } =
    await buildUnpublishScenario();

  assert.deepEqual(unpublishedRow, sourceRowSnapshot);
  assert.equal(rowValue(unpublishedRow, COMMON_COLUMN_TITLES.recordId), "SEQI-0050");
  assert.equal(rowValue(unpublishedRow, COMMON_COLUMN_TITLES.publicationDate), "2026-06-10");
  assert.equal(rowValue(unpublishedRow, COMMON_COLUMN_TITLES.photoFilename), "published-a.jpg");
  assert.equal(
    rowValue(unpublishedRow, COMMON_COLUMN_TITLES.publicationStatus),
    DO_NOT_PUBLISH_STATUS
  );
  assert.equal(unpublishPlan.writeBackRows.length, 0);
  assert.equal(
    await readFile(join(imagesDirectory, "seqi-0050.jpg"), "utf8"),
    "synthetic image bytes"
  );
});

test("Do not publish to Ready republishes the same record ID without duplication", async () => {
  const { imagesDirectory, unpublishPlan } = await buildUnpublishScenario();
  const republishPlan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0050",
        rowId: 50,
        status: READY_TO_PUBLISH_STATUS,
        photoFilename: "published-a.jpg",
        publicationDate: "2026-06-10",
        title: "Published A"
      }),
      projectRow({
        recordId: "SEQI-0051",
        rowId: 51,
        status: PUBLISHED_STATUS,
        photoFilename: "published-b.jpg",
        publicationDate: "2026-06-11",
        title: "Published B"
      })
    ]),
    currentRecords: unpublishPlan.records,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0050", "SEQI-0051"])
  });

  assert.deepEqual(
    republishPlan.records.map(record => record.id),
    ["SEQI-0050", "SEQI-0051"]
  );
  assert.equal(new Set(republishPlan.records.map(record => record.id)).size, 2);
  assert.equal(republishPlan.records[0].photo, "images/seqi-0050.jpg");
  assert.equal(republishPlan.records[0].publishedOn, "10 June 2026");
  assert.equal(republishPlan.writeBackRows[0].recordId, "SEQI-0050");
  assert.equal(republishPlan.writeBackRows[0].recordIdWasBlank, false);
  assert.equal(republishPlan.writeBackRows[0].markPublished, true);
});

test("Unchanged Published records produce no publication work", async () => {
  const imagesDirectory = await tempImages(["seqi-0052.jpg"]);
  const sourceSheet = sheet([
    projectRow({
      recordId: "SEQI-0052",
      rowId: 52,
      status: PUBLISHED_STATUS,
      photoFilename: "seqi-0052.jpg",
      publicationDate: "2026-06-12"
    })
  ]);
  const initialPlan = await buildPublishPlan({
    sheet: sourceSheet,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0052"])
  });
  const repeatedPlan = await buildPublishPlan({
    sheet: sourceSheet,
    currentRecords: initialPlan.records,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0052"])
  });

  assert.deepEqual(detectPublicationWork(initialPlan.serialized, repeatedPlan), {
    shouldPublish: false,
    galleryChanged: false,
    hasReadyRows: false,
    hasWriteBackRows: false
  });
});

test("A website-impacting Published field change triggers publication without Ready rows", async () => {
  const imagesDirectory = await tempImages(["seqi-0053.jpg"]);
  const originalSheet = sheet([
    projectRow({
      recordId: "SEQI-0053",
      status: PUBLISHED_STATUS,
      photoFilename: "seqi-0053.jpg",
      title: "Original title"
    })
  ]);
  const originalPlan = await buildPublishPlan({
    sheet: originalSheet,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0053"])
  });
  const changedPlan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0053",
        status: PUBLISHED_STATUS,
        photoFilename: "seqi-0053.jpg",
        title: "Updated title"
      })
    ]),
    currentRecords: originalPlan.records,
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0053"])
  });

  assert.equal(changedPlan.writeBackRows.length, 0);
  assert.equal(detectPublicationWork(originalPlan.serialized, changedPlan).shouldPublish, true);
});

test("A failed unpublish deployment has no Smartsheet write-back payload", async () => {
  const { unpublishedRow, sourceRowSnapshot, unpublishPlan } = await buildUnpublishScenario();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("Smartsheet should not be called for an unpublish write-back");
  };

  try {
    const result = await updateSmartsheetRows("sheet", "token", unpublishPlan.writeBackRows);
    assert.equal(result.updatedCount, 0);
    assert.equal(fetchCalled, false);
    assert.deepEqual(unpublishedRow, sourceRowSnapshot);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 3 counts only Ready rows as new publication work", () => {
  assert.equal(
    countReadyToPublishRows(
      sheet([
        projectRow({ recordId: "SEQI-0001", status: READY_TO_PUBLISH_STATUS }),
        projectRow({ recordId: "SEQI-0002", status: PUBLISHED_STATUS }),
        projectRow({ recordId: "SEQI-0003", status: "Draft" })
      ])
    ),
    1
  );
});

test("Phase 3 generates missing Ready IDs after the highest reserved sequence", () => {
  const sourceSheet = sheet([
    projectRow({ recordId: "SEQI-0009", status: PUBLISHED_STATUS, rowId: 9 }),
    projectRow({ recordId: "SEQI-0012", status: "Draft", rowId: 12 }),
    projectRow({ recordId: "", status: READY_TO_PUBLISH_STATUS, rowId: 20 })
  ]);
  const result = assignMissingReadyRecordIds(sourceSheet);
  assert.equal(result.generatedRecordIdByRowId.get(20), "SEQI-0013");
  assert.equal(
    result.sheet.rows[2].cells.find(
      item => item.columnId === columnIdByTitle.get(COMMON_COLUMN_TITLES.recordId)
    ).value,
    "SEQI-0013"
  );
});

test("Phase 3 writes generated IDs into the publication plan", async () => {
  const imagesDirectory = await tempImages(["seqi-0014.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0014",
        status: PUBLISHED_STATUS,
        rowId: 14
      }),
      projectRow({ recordId: "", status: READY_TO_PUBLISH_STATUS, rowId: 15 })
    ]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0014", "SEQI-0015"])
  });
  assert.deepEqual(
    plan.records.map(record => record.id),
    ["SEQI-0014", "SEQI-0015"]
  );
  const generatedIdWriteBack = plan.writeBackRows.find(row => row.recordId === "SEQI-0015");
  assert.equal(generatedIdWriteBack.recordIdWasBlank, true);
});

test("Phase 3 rejects duplicate IDs anywhere in the source sheet", () => {
  assert.throws(
    () =>
      assignMissingReadyRecordIds(
        sheet([
          projectRow({
            recordId: "SEQI-0020",
            status: PUBLISHED_STATUS,
            rowId: 20
          }),
          projectRow({ recordId: "SEQI-0020", status: "Draft", rowId: 21 })
        ])
      ),
    PublishValidationError
  );
});

test("Phase 3 rejects unapproved generated sustainability categories", () => {
  assert.throws(
    () =>
      validateGeneratedWebsiteRecords([
        {
          id: "SEQI-0021",
          sustainabilityPrinciples: ["Retired category"],
          sustainabilityOpportunities: []
        }
      ]),
    PublishValidationError
  );
});

test("Phase 3 rejects null and non-finite generated values", () => {
  assert.throws(
    () =>
      validateGeneratedWebsiteRecords([
        {
          id: "SEQI-0022",
          optionalText: null,
          invalidMetric: Number.NaN,
          sustainabilityPrinciples: [],
          sustainabilityOpportunities: []
        }
      ]),
    PublishValidationError
  );
});

test("Phase 3 keeps optional blank fields render-safe", async () => {
  const imagesDirectory = await tempImages(["seqi-0023.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0023",
        cells: {
          [COMMON_COLUMN_TITLES.contactEmail]: "",
          [COMMON_COLUMN_TITLES.department]: "",
          [COMMON_COLUMN_TITLES.province]: "",
          "Healthcare setting": "",
          "Prevention - Comments": ""
        }
      })
    ]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0023"])
  });
  assert.equal(plan.records[0].email, "");
  assert.equal(plan.records[0].healthcareSetting, "");
  assert.equal(plan.records[0].sustainabilityOpportunities[0].explanation, "");
  assert.doesNotMatch(plan.serialized, /\b(?:undefined|NaN)\b/);
});

test("Phase 3 reuses an existing canonical image after checking its row attachment", async () => {
  const imagesDirectory = await tempImages(["seqi-0001.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([projectRow({ photoFilename: "existing.jpg" })]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0001"])
  });
  assert.equal(plan.summary.reusedImageCount, 1);
  assert.equal(plan.downloadedImages.length, 0);
  assert.equal(plan.records[0].photo, "images/seqi-0001.jpg");
  assert.equal(plan.writeBackRows[0].finalPhotoFilename, "seqi-0001.jpg");
});

for (const [name, attachmentName, expectedFilename] of [
  ["JPEG", "photo.jpeg", "seqi-0012.jpg"],
  ["PNG", "photo.PNG", "seqi-0013.png"],
  ["WebP", "photo.webp", "seqi-0014.webp"]
]) {
  test(`Phase 3 generates stable ${name} filename`, async () => {
    const recordId = expectedFilename.replace(/\.[^.]+$/, "").toUpperCase();
    const imagesDirectory = await tempImages([]);
    const tempDirectory = await mkdtemp(join(tmpdir(), "seqi-test-temp-"));
    const attachments = new Map([
      [
        recordId,
        [
          {
            id: 1,
            name: attachmentName,
            sizeInBytes: 1024
          }
        ]
      ]
    ]);
    const plan = await buildPublishPlan({
      sheet: sheet([projectRow({ recordId, photoFilename: "" })]),
      imagesDirectory,
      tempDirectory,
      attachmentClient: attachmentClientFor(attachments)
    });
    assert.equal(generatedImageFilename(recordId, attachments.get(recordId)[0]), expectedFilename);
    assert.equal(plan.records[0].photo, `images/${expectedFilename}`);
    assert.equal(plan.downloadedImages[0].filename, expectedFilename);
  });
}

test("Phase 3 fails when no supported image attachment exists", async () => {
  const imagesDirectory = await tempImages([]);
  await expectPublishValidation(
    "no image",
    () =>
      buildPublishPlan({
        sheet: sheet([projectRow({ recordId: "SEQI-0020", photoFilename: "" })]),
        imagesDirectory,
        tempDirectory: tmpdir(),
        attachmentClient: attachmentClientFor(new Map([["SEQI-0020", []]]))
      }),
    "found 0"
  );
});

test("Phase 3 fails when multiple supported image attachments exist", async () => {
  const imagesDirectory = await tempImages([]);
  await expectPublishValidation(
    "multiple image",
    () =>
      buildPublishPlan({
        sheet: sheet([projectRow({ recordId: "SEQI-0021", photoFilename: "" })]),
        imagesDirectory,
        tempDirectory: tmpdir(),
        attachmentClient: attachmentClientFor(
          new Map([
            [
              "SEQI-0021",
              [
                { id: 1, name: "a.jpg", sizeInBytes: 100 },
                { id: 2, name: "b.png", sizeInBytes: 100 }
              ]
            ]
          ])
        )
      }),
    "found 2"
  );
});

test("Phase 3 fails unsupported image attachment type", async () => {
  const imagesDirectory = await tempImages([]);
  await expectPublishValidation(
    "unsupported image",
    () =>
      buildPublishPlan({
        sheet: sheet([projectRow({ recordId: "SEQI-0022", photoFilename: "" })]),
        imagesDirectory,
        tempDirectory: tmpdir(),
        attachmentClient: attachmentClientFor(
          new Map([["SEQI-0022", [{ id: 1, name: "a.gif", sizeInBytes: 100 }]]])
        )
      }),
    "found 0"
  );
});

test("Phase 3 fails oversized image attachment", async () => {
  const imagesDirectory = await tempImages([]);
  await expectPublishValidation(
    "oversized image",
    () =>
      buildPublishPlan({
        sheet: sheet([projectRow({ recordId: "SEQI-0023", photoFilename: "" })]),
        imagesDirectory,
        tempDirectory: tmpdir(),
        attachmentClient: attachmentClientFor(
          new Map([["SEQI-0023", [{ id: 1, name: "a.jpg", sizeInBytes: MAX_IMAGE_BYTES + 1 }]]])
        )
      }),
    "exceeds 10 MB"
  );
});

test("Phase 3 fails duplicate Website record ID", async () => {
  const imagesDirectory = await tempImages(["a.jpg", "b.jpg"]);
  await expectPublishValidation(
    "duplicate id",
    () =>
      buildPublishPlan({
        sheet: sheet([
          projectRow({ recordId: "SEQI-0030", photoFilename: "a.jpg" }),
          projectRow({ recordId: "SEQI-0030", photoFilename: "b.jpg" })
        ]),
        imagesDirectory,
        tempDirectory: tmpdir(),
        attachmentClient: forbiddenAttachmentClient()
      }),
    "Duplicate Website record ID"
  );
});

test("Phase 3 preserves an existing Published date when Smartsheet date is blank", async () => {
  const imagesDirectory = await tempImages(["seqi-0031.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0031",
        status: PUBLISHED_STATUS,
        photoFilename: "seqi-0031.jpg",
        publicationDate: ""
      })
    ]),
    currentRecords: [
      {
        id: "SEQI-0031",
        photo: "images/seqi-0031.jpg",
        publishedOn: "19 June 2026"
      }
    ],
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0031"])
  });
  assert.equal(plan.records[0].publishedOn, "19 June 2026");
  assert.equal(plan.writeBackRows.length, 0);
});

test("Phase 3 skips a new Ready row with a blank publication date", async () => {
  const imagesDirectory = await tempImages([]);
  const plan = await buildPublishPlan({
    sheet: sheet([projectRow({ recordId: "SEQI-0032", publicationDate: "" })]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0032"])
  });
  assert.deepEqual(plan.records, []);
  assert.equal(plan.writeBackRows.length, 0);
  assert.equal(plan.summary.readyToPublishCount, 0);
  assert.equal(plan.summary.skippedMissingPublicationDateCount, 1);
  assert.equal(plan.summary.skippedMissingPublicationDateRows[0].recordId, "SEQI-0032");
});

test("Phase 3 skips a Ready row with a blank date without removing its live record", async () => {
  const imagesDirectory = await tempImages(["seqi-0033.jpg"]);
  const currentRecord = {
    id: "SEQI-0033",
    type: "project",
    title: "Published before",
    photo: "images/seqi-0033.jpg",
    photoAlt: "Published before",
    province: "British Columbia",
    publishedOn: "10 July 2026",
    contactName: "Synthetic Respondent",
    email: "synthetic@example.test",
    organization: "Synthetic Organization",
    department: "Synthetic Department",
    stage: "Complete",
    healthcareSetting: "Synthetic setting",
    description: "Existing public record",
    cobenefit: "",
    sustainabilityPrinciples: [],
    sustainabilityOpportunities: [],
    metrics: { environmental: [], activity: [] },
    domainsOfQuality: []
  };
  const plan = await buildPublishPlan({
    sheet: sheet([projectRow({ recordId: "SEQI-0033", publicationDate: "" })]),
    currentRecords: [currentRecord],
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0033"])
  });

  assert.deepEqual(plan.records, [currentRecord]);
  assert.equal(plan.writeBackRows.length, 0);
  assert.equal(plan.summary.skippedMissingPublicationDateCount, 1);
});

test("Phase 3 rejects the wrong production repository", () => {
  assert.throws(
    () =>
      assertProductionPublishGuards({
        repository: "Seya1234/live-repo",
        refName: MAIN_BRANCH
      }),
    /repository/
  );
});

test("Phase 3 accepts the production repository main branch", () => {
  assert.doesNotThrow(() =>
    assertProductionPublishGuards({
      repository: PRODUCTION_REPOSITORY,
      refName: MAIN_BRANCH
    })
  );
});

test("Phase 3 detects no-change publishing", async () => {
  const imagesDirectory = await tempImages(["seqi-0001.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([projectRow({ photoFilename: "seqi-0001.jpg" })]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0001"])
  });
  assert.equal(detectNoChange(plan.serialized, plan), true);
  assert.deepEqual(detectPublicationWork(plan.serialized, plan), {
    shouldPublish: true,
    galleryChanged: false,
    hasReadyRows: true,
    hasWriteBackRows: true
  });
});

test("Phase 3 builds successful Smartsheet write-back payload", () => {
  const payload = buildSmartsheetWriteBackPayload([
    {
      recordId: "SEQI-0040",
      rowId: 10,
      recordIdColumnId: 15,
      statusColumnId: 20,
      photoFilenameColumnId: 40,
      markPublished: true,
      finalPhotoFilename: "seqi-0040.jpg",
      recordIdWasBlank: true
    }
  ]);
  assert.deepEqual(payload, [
    {
      id: 10,
      cells: [
        { columnId: 20, value: PUBLISHED_STATUS, strict: false },
        { columnId: 40, value: "seqi-0040.jpg", strict: false },
        { columnId: 15, value: "SEQI-0040", strict: false }
      ]
    }
  ]);
});

test("Phase 3 builds photo-only Smartsheet write-back payload", () => {
  const payload = buildSmartsheetWriteBackPayload([
    {
      recordId: "SEQI-0001",
      rowId: 1,
      recordIdColumnId: 15,
      statusColumnId: 20,
      photoFilenameColumnId: 40,
      markPublished: false,
      finalPhotoFilename: "seqi-0001.jpg",
      recordIdWasBlank: false
    }
  ]);
  assert.deepEqual(payload, [
    {
      id: 1,
      cells: [{ columnId: 40, value: "seqi-0001.jpg", strict: false }]
    }
  ]);
});

test("Phase 3 sends successful Smartsheet write-back request", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          message: "SUCCESS",
          resultCode: 0,
          result: []
        };
      }
    };
  };

  try {
    const result = await updateSmartsheetRows("sheet", "token", [
      {
        recordId: "SEQI-0040",
        rowId: 10,
        statusColumnId: 20,
        photoFilenameColumnId: 40,
        markPublished: true,
        finalPhotoFilename: "seqi-0040.jpg"
      }
    ]);
    assert.equal(result.updatedCount, 1);
    assert.equal(captured[0].id, 10);
    assert.deepEqual(captured[0].cells, [
      { columnId: 20, value: PUBLISHED_STATUS, strict: false },
      { columnId: 40, value: "seqi-0040.jpg", strict: false }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 3 reports partial Smartsheet write-back failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        message: "PARTIAL_SUCCESS",
        failedItems: [{}]
      };
    }
  });

  try {
    await expectPublishValidation(
      "partial writeback",
      () =>
        updateSmartsheetRows("sheet", "token", [
          {
            recordId: "SEQI-0041",
            rowId: 1,
            statusColumnId: 2,
            photoFilenameColumnId: 4,
            markPublished: true,
            finalPhotoFilename: "seqi-0041.jpg"
          }
        ]),
      "write-back did not fully succeed"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 3 safe rerun reuses committed image after Smartsheet write-back failure", async () => {
  const imagesDirectory = await tempImages(["seqi-0042.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([
      projectRow({
        recordId: "SEQI-0042",
        photoFilename: "",
        publicationDate: "2026-07-14"
      })
    ]),
    currentRecords: [
      {
        id: "SEQI-0042",
        photo: "images/seqi-0042.jpg",
        publishedOn: "14 July 2026"
      }
    ],
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0042"])
  });
  assert.equal(plan.downloadedImages.length, 0);
  assert.equal(plan.records[0].photo, "images/seqi-0042.jpg");
  assert.equal(plan.writeBackRows[0].finalPhotoFilename, "seqi-0042.jpg");
});

test("Phase 3 supports initiatives in the publish output", async () => {
  const imagesDirectory = await tempImages(["seqi-0100.jpg"]);
  const plan = await buildPublishPlan({
    sheet: sheet([initiativeRow()]),
    imagesDirectory,
    tempDirectory: await mkdtemp(join(tmpdir(), "seqi-test-temp-")),
    attachmentClient: attachmentClientForRecordIds(["SEQI-0100"])
  });
  assert.equal(plan.records[0].type, "initiative");
  assert.equal(plan.summary.initiativeCount, 1);
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

console.log(`${passed} synthetic publishing tests passed.`);
