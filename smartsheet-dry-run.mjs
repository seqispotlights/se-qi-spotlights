const SMARTSHEET_API_BASE = "https://api.smartsheet.com/2.0";
const REQUIRED_COLUMN_TITLES = [
  "Website record ID",
  "Website publication status",
  "Website publication date",
  "Website photo filename"
];
const READY_TO_PUBLISH_STATUS = "Ready to publish";
const TOOLKIT_USE_COLUMN_TITLE = "Intended toolkit use";

function requireEnv(name) {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value.trim();
}

function trimText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function buildColumnLookup(columns) {
  const lookup = new Map();

  for (const column of columns) {
    const title = trimText(column.title);
    if (title) lookup.set(title, column);
  }

  return lookup;
}

function getCellByColumnId(row, columnId) {
  return (row.cells || []).find(cell => cell.columnId === columnId);
}

function getCellText(row, column) {
  if (!column) return "";

  const cell = getCellByColumnId(row, column.id);
  if (!cell) return "";

  if (cell.displayValue !== undefined) return trimText(cell.displayValue);
  if (cell.value !== undefined) return trimText(cell.value);
  if (cell.objectValue !== undefined) return trimText(JSON.stringify(cell.objectValue));

  return "";
}

function getToolkitUseValues(row, column) {
  if (!column) return ["Unspecified"];

  const cell = getCellByColumnId(row, column.id);
  if (!cell) return ["Unspecified"];

  const objectValues = cell.objectValue?.values;
  if (Array.isArray(objectValues)) {
    const values = objectValues.map(trimText).filter(Boolean);
    return values.length > 0 ? values : ["Unspecified"];
  }

  const value = getCellText(row, column);
  return value ? [value] : ["Unspecified"];
}

function findDuplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates].sort();
}

async function fetchSheet(sheetId, accessToken) {
  const response = await fetch(
    `${SMARTSHEET_API_BASE}/sheets/${encodeURIComponent(sheetId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Smartsheet API request failed with HTTP ${response.status} ${response.statusText}.`
    );
  }

  return response.json();
}

function summarizeSheet(sheet) {
  const columns = Array.isArray(sheet.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const columnLookup = buildColumnLookup(columns);
  const columnTitles = columns.map(column => trimText(column.title)).filter(Boolean);

  const missingRequiredColumns = REQUIRED_COLUMN_TITLES.filter(
    title => !columnLookup.has(title)
  );

  if (missingRequiredColumns.length > 0) {
    throw new Error(
      `Missing required column(s): ${missingRequiredColumns.join(", ")}.`
    );
  }

  const recordIdColumn = columnLookup.get("Website record ID");
  const statusColumn = columnLookup.get("Website publication status");
  const toolkitUseColumn = columnLookup.get(TOOLKIT_USE_COLUMN_TITLE);

  const allRecordIds = rows
    .map(row => getCellText(row, recordIdColumn))
    .filter(Boolean);
  const duplicateRecordIds = findDuplicateValues(allRecordIds);

  if (duplicateRecordIds.length > 0) {
    throw new Error(
      `Duplicate Website record ID value(s) detected: ${duplicateRecordIds.join(", ")}.`
    );
  }

  const readyRows = rows.filter(
    row => getCellText(row, statusColumn) === READY_TO_PUBLISH_STATUS
  );
  const readyRecordIds = readyRows
    .map(row => getCellText(row, recordIdColumn))
    .filter(Boolean);

  const toolkitUseCounts = {};
  for (const row of rows) {
    for (const value of getToolkitUseValues(row, toolkitUseColumn)) {
      toolkitUseCounts[value] = (toolkitUseCounts[value] || 0) + 1;
    }
  }

  const requiredColumnStatus = Object.fromEntries(
    REQUIRED_COLUMN_TITLES.map(title => [title, columnLookup.has(title)])
  );

  return {
    connectionSucceeded: true,
    sheetName: trimText(sheet.name),
    columnCount: columns.length,
    rowCount: rows.length,
    columnTitles,
    requiredColumnStatus,
    readyToPublishRowCount: readyRows.length,
    readyToPublishWebsiteRecordIds: readyRecordIds,
    intendedToolkitUseCounts: Object.fromEntries(
      Object.entries(toolkitUseCounts).sort(([a], [b]) => a.localeCompare(b))
    )
  };
}

async function main() {
  const accessToken = requireEnv("SMARTSHEET_ACCESS_TOKEN");
  const sheetId = requireEnv("SMARTSHEET_SHEET_ID");
  const sheet = await fetchSheet(sheetId, accessToken);
  const summary = summarizeSheet(sheet);

  console.log("Smartsheet connection test succeeded.");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(`Smartsheet connection test failed: ${error.message}`);
  process.exitCode = 1;
});
