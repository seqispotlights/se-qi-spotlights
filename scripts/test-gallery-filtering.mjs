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
  projectCount: { textContent: "" }
};

const documentStub = {
  addEventListener() {},
  getElementById(id) {
    return elements[id] || null;
  },
  querySelectorAll() {
    return [];
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

const context = vm.createContext({
  console,
  document: documentStub,
  window: {
    addEventListener() {},
    scrollTo() {},
    scrollY: 0
  },
  fetch: async () => {
    throw new Error("Network access is not expected in gallery filtering tests.");
  }
});

const source = await readFile(new URL("../src/script.js", import.meta.url), "utf8");
const testBridge = `
  buildTile = project => ({ project });
  globalThis.galleryTest = {
    setProjectData,
    projectMatchesFilters,
    renderProjects,
    renderInitiatives,
    clearAllFilters,
    setFilters(filters) {
      activeFilters.province.clear();
      activeFilters.sustainabilityPrinciples.clear();
      (filters.province || []).forEach(value => activeFilters.province.add(value));
      (filters.sustainabilityPrinciples || []).forEach(value =>
        activeFilters.sustainabilityPrinciples.add(value)
      );
    }
  };
`;
vm.runInContext(`${source}\n${testBridge}`, context, { filename: "src/script.js" });

const projectBc = {
  id: "PROJECT-BC",
  type: "project",
  title: "BC project",
  province: "British Columbia",
  sustainabilityPrinciples: ["Prevention"]
};
const projectOntario = {
  id: "PROJECT-ON",
  type: "project",
  title: "Ontario project",
  province: "Ontario",
  sustainabilityPrinciples: ["Mitigation / Decarbonization"]
};
const initiativeBc = {
  id: "INITIATIVE-BC",
  type: "initiative",
  title: "BC initiative",
  province: "British Columbia",
  sustainabilityPrinciples: ["Prevention"]
};
const initiativeOntario = {
  id: "INITIATIVE-ON",
  type: "initiative",
  title: "Ontario initiative",
  province: "Ontario",
  sustainabilityPrinciples: ["Mitigation / Decarbonization"]
};

const { galleryTest } = context;
galleryTest.setProjectData([projectBc, projectOntario, initiativeBc, initiativeOntario]);

function renderedIds(grid) {
  return grid.children.map(tile => tile.project.id);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

test("initiatives use the same province filter as projects", () => {
  galleryTest.setFilters({ province: ["British Columbia"] });
  galleryTest.renderProjects();
  galleryTest.renderInitiatives();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC"]);
  assert.deepEqual(renderedIds(elements.initiativeGrid), ["INITIATIVE-BC"]);
});

test("non-matching initiatives disappear while matching initiatives remain", () => {
  galleryTest.setFilters({ sustainabilityPrinciples: ["Mitigation / Decarbonization"] });
  galleryTest.renderInitiatives();
  assert.deepEqual(renderedIds(elements.initiativeGrid), ["INITIATIVE-ON"]);
});

test("initiative section hides when no initiatives match", () => {
  galleryTest.setFilters({ province: ["Manitoba"] });
  galleryTest.renderInitiatives();
  assert.deepEqual(renderedIds(elements.initiativeGrid), []);
  assert.equal(elements.initiativesSection.style.display, "none");
});

test("multiple simultaneous filters apply to both gallery sections", () => {
  galleryTest.setFilters({
    province: ["British Columbia"],
    sustainabilityPrinciples: ["Mitigation / Decarbonization"]
  });
  galleryTest.renderProjects();
  galleryTest.renderInitiatives();
  assert.deepEqual(renderedIds(elements.projectGrid), []);
  assert.deepEqual(renderedIds(elements.initiativeGrid), []);
  assert.equal(elements.initiativesSection.style.display, "none");
});

test("clearing filters restores projects, initiatives, and initiative heading", () => {
  galleryTest.clearAllFilters();
  assert.deepEqual(renderedIds(elements.projectGrid), ["PROJECT-BC", "PROJECT-ON"]);
  assert.deepEqual(renderedIds(elements.initiativeGrid), ["INITIATIVE-BC", "INITIATIVE-ON"]);
  assert.equal(elements.initiativesSection.style.display, "");
});

console.log(`${passed} gallery filtering tests passed.`);
