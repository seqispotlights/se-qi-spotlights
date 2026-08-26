import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function makeGrid() {
  return {
    children: [],
    set innerHTML(_value) {
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
    }
  };
}

const elements = {
  projectGrid: makeGrid(),
  initiativeGrid: makeGrid(),
  initiativesSection: { style: { display: "" } },
  emptyState: { style: { display: "none" } },
  projectCount: { textContent: "" },
  projectSearch: { value: "" },
  clearSearch: { hidden: true }
};

const checkboxStubs = [];
const documentStub = {
  addEventListener() {},
  getElementById(id) {
    return elements[id] || null;
  },
  querySelectorAll(selector) {
    return selector === ".filter-checkbox" ? checkboxStubs : [];
  },
  body: {
    classList: {
      contains() {
        return false;
      },
      toggle() {}
    }
  }
};

const taxonomy = JSON.parse(
  await readFile(new URL("../data/sustainability-taxonomy.json", import.meta.url), "utf8")
);
const context = vm.createContext({
  console,
  document: documentStub,
  TEST_TAXONOMY: taxonomy,
  window: {
    addEventListener() {},
    location: { search: "" },
    scrollTo() {},
    scrollY: 0
  },
  fetch: async () => {
    throw new Error("Network access is not expected in gallery filtering tests.");
  }
});

const source = await readFile(new URL("../src/script.js", import.meta.url), "utf8");
const testBridge = `
  SUSTAINABILITY_TAXONOMY = TEST_TAXONOMY;
  buildTile = project => ({ project });
  globalThis.galleryTest = {
    setProjectData,
    projectMatchesFilters,
    renderProjects,
    renderInitiatives,
    clearAllFilters,
    setAccordionExpanded,
    setFilters(filters = {}) {
      activeFilters.province.clear();
      activeFilters.sustainabilityPrinciples.clear();
      activeFilters.opportunityCategories.clear();
      activeFilters.opportunityDetails.clear();
      searchQuery = String(filters.search || "");
      (filters.province || []).forEach(value => activeFilters.province.add(value));
      (filters.sustainabilityPrinciples || []).forEach(value =>
        activeFilters.sustainabilityPrinciples.add(value)
      );
      (filters.opportunityCategories || []).forEach(value =>
        activeFilters.opportunityCategories.add(value)
      );
      (filters.opportunityDetails || []).forEach(([categoryKey, value]) =>
        activeFilters.opportunityDetails.add(opportunityDetailToken(categoryKey, value))
      );
    },
    snapshotFilters() {
      return {
        province: [...activeFilters.province],
        sustainabilityPrinciples: [...activeFilters.sustainabilityPrinciples],
        opportunityCategories: [...activeFilters.opportunityCategories],
        opportunityDetails: [...activeFilters.opportunityDetails],
        search: searchQuery
      };
    }
  };
`;
vm.runInContext(`${source}\n${testBridge}`, context, { filename: "src/script.js" });

function opportunities(overrides = {}) {
  return {
    prevention: [],
    stewardshipAppropriateness: [],
    mitigationDecarbonization: [],
    climateResilienceAdaptation: [],
    clinicalSpecialtyTreatmentModality: [],
    ...overrides
  };
}

const projectBcWaste = {
  id: "PROJECT-BC-WASTE",
  type: "project",
  title: "Laboratory waste reduction",
  province: "British Columbia",
  sustainabilityPrinciples: ["Stewardship / Appropriateness"],
  sustainabilityOpportunities: opportunities({
    prevention: ["Avoiding Complications of Care"],
    stewardshipAppropriateness: ["Minimize Delays in Care"],
    mitigationDecarbonization: ["Care coordination", "Waste management"],
    climateResilienceAdaptation: ["Healthcare delivery resilience"],
    clinicalSpecialtyTreatmentModality: ["Clinical Laboratory"]
  }),
  Prevention: true
};
const projectOntarioPrevention = {
  id: "PROJECT-ON-PREVENTION",
  type: "project",
  title: "Community primary care",
  province: "Ontario",
  sustainabilityPrinciples: ["Prevention"],
  sustainabilityOpportunities: opportunities({
    prevention: ["Health Promotion / Primary Prevention"],
    stewardshipAppropriateness: ["Avoid Unnecessary Hospital-based Care"],
    climateResilienceAdaptation: ["Patient resilience"],
    clinicalSpecialtyTreatmentModality: ["Primary Care"]
  }),
  Prevention: false
};
const projectBcEnergy = {
  id: "PROJECT-BC-ENERGY",
  type: "project",
  title: "Lower-energy primary care",
  province: "British Columbia",
  sustainabilityPrinciples: ["Decarbonization / Depollution"],
  sustainabilityOpportunities: opportunities({
    mitigationDecarbonization: ["Energy"],
    clinicalSpecialtyTreatmentModality: ["Primary Care"]
  })
};
const initiativeBcWaste = {
  id: "INITIATIVE-BC-WASTE",
  type: "initiative",
  title: "BC waste initiative",
  province: "British Columbia",
  sustainabilityPrinciples: ["Prevention"],
  sustainabilityOpportunities: opportunities({
    mitigationDecarbonization: ["Waste management"]
  })
};

const allRecords = [
  projectBcWaste,
  projectOntarioPrevention,
  projectBcEnergy,
  initiativeBcWaste
];
const { galleryTest } = context;
galleryTest.setProjectData(allRecords);

function renderedIds(grid) {
  return grid.children.map(tile => tile.project.id);
}

function renderBoth() {
  galleryTest.renderProjects();
  galleryTest.renderInitiatives();
}

function snapshotFilters() {
  return JSON.parse(JSON.stringify(galleryTest.snapshotFilters()));
}

let passed = 0;
function test(name, fn) {
  galleryTest.setProjectData(allRecords);
  galleryTest.setFilters();
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

test("Test 1 - Province filter returns only British Columbia projects", () => {
  galleryTest.setFilters({ province: ["British Columbia"] });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE", "PROJECT-BC-ENERGY"]);
});

test("Test 2 - Principle filter uses Sustainability Principles, not the retired checkbox", () => {
  galleryTest.setFilters({ sustainabilityPrinciples: ["Prevention"] });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-ON-PREVENTION"]);
});

test("Test 3 - Opportunity parent matches any populated category value", () => {
  galleryTest.setFilters({ opportunityCategories: ["mitigationDecarbonization"] });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE", "PROJECT-BC-ENERGY"]);
});

test("Test 4 - Opportunity child requires an exact nested value", () => {
  galleryTest.setFilters({
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);
});

test("Test 5 - A multi-select record matches each selected child independently", () => {
  galleryTest.setFilters({
    opportunityDetails: [["mitigationDecarbonization", "Care coordination"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);

  galleryTest.setFilters({
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);
});

test("Test 6 - Clinical specialty child filter returns Primary Care records", () => {
  galleryTest.setFilters({
    opportunityDetails: [["clinicalSpecialtyTreatmentModality", "Primary Care"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), [
    "PROJECT-ON-PREVENTION",
    "PROJECT-BC-ENERGY"
  ]);
});

test("Test 7 - Province, principle, and opportunity combine with AND logic", () => {
  galleryTest.setFilters({
    province: ["British Columbia"],
    sustainabilityPrinciples: ["Stewardship / Appropriateness"],
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);
});

test("Test 8 - Principles and opportunities remain independent dimensions", () => {
  galleryTest.setFilters({
    sustainabilityPrinciples: ["Stewardship / Appropriateness"],
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);
});

test("Test 9 - Collapsing and reopening an accordion preserves filter selection", () => {
  galleryTest.setFilters({
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]]
  });
  const attributes = new Map([["aria-expanded", "true"]]);
  const button = {
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };
  const panel = { hidden: false };

  galleryTest.setAccordionExpanded(button, panel, false);
  assert.equal(panel.hidden, true);
  assert.equal(snapshotFilters().opportunityDetails.length, 1);

  galleryTest.setAccordionExpanded(button, panel, true);
  assert.equal(panel.hidden, false);
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(snapshotFilters().opportunityDetails.length, 1);
});

test("Test 10 - Clear Filters resets every new filter without clearing search", () => {
  galleryTest.setFilters({
    province: ["British Columbia"],
    sustainabilityPrinciples: ["Stewardship / Appropriateness"],
    opportunityCategories: ["mitigationDecarbonization"],
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]],
    search: "waste"
  });
  checkboxStubs.splice(0, checkboxStubs.length, { checked: true }, { checked: true });
  galleryTest.clearAllFilters();

  assert.deepEqual(snapshotFilters(), {
    province: [],
    sustainabilityPrinciples: [],
    opportunityCategories: [],
    opportunityDetails: [],
    search: "waste"
  });
  assert.ok(checkboxStubs.every(checkbox => checkbox.checked === false));
});

test("Test 11 - Search and filters apply together without resetting each other", () => {
  galleryTest.setFilters({
    province: ["British Columbia"],
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]],
    search: "laboratory"
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);
  assert.deepEqual(snapshotFilters().province, ["British Columbia"]);
  assert.equal(snapshotFilters().search, "laboratory");
});

test("Test 12 - Records work when all five retired checkbox fields are absent", () => {
  const recordWithoutRetiredFields = {
    id: "PROJECT-NEW-SCHEMA",
    type: "project",
    title: "New schema only",
    province: "Alberta",
    sustainabilityPrinciples: ["Prevention"],
    sustainabilityOpportunities: opportunities({
      mitigationDecarbonization: ["Waste management"]
    })
  };
  for (const retiredField of [
    "Prevention",
    "Stewardship / Appropriateness",
    "Climate resilience and adaptation",
    "Clinical specialty or treatment modality",
    "Mitigation / Decarbonization"
  ]) {
    assert.equal(Object.hasOwn(recordWithoutRetiredFields, retiredField), false);
  }

  galleryTest.setProjectData([recordWithoutRetiredFields]);
  galleryTest.setFilters({ opportunityCategories: ["mitigationDecarbonization"] });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-NEW-SCHEMA"]);
});

test("Within-group selections use OR logic", () => {
  galleryTest.setFilters({
    sustainabilityPrinciples: ["Prevention", "Decarbonization / Depollution"]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), [
    "PROJECT-ON-PREVENTION",
    "PROJECT-BC-ENERGY"
  ]);
});

test("Selecting an opportunity parent and child does not create an impossible AND", () => {
  galleryTest.setFilters({
    opportunityCategories: ["mitigationDecarbonization"],
    opportunityDetails: [["clinicalSpecialtyTreatmentModality", "Dentistry"]]
  });
  galleryTest.renderProjects();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE", "PROJECT-BC-ENERGY"]);
});

test("Initiatives use the same nested filters as project cards", () => {
  galleryTest.setFilters({
    province: ["British Columbia"],
    opportunityDetails: [["mitigationDecarbonization", "Waste management"]]
  });
  renderBoth();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC-WASTE"]);
  assert.deepEqual(renderedIds(elements.initiativeGrid), ["INITIATIVE-BC-WASTE"]);
  assert.equal(elements.initiativesSection.style.display, "");
});

console.log(`${passed} gallery filtering tests passed.`);
