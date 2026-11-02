import assert from "node:assert/strict";

await import("../src/cwc-alignment.js");

const { buildSectionHTML, isAligned, modelFor, specialtyGroups } = globalThis.CWCAlignment;

const oneRecommendation = {
  cwcAlignment: "Yes",
  cwcSpecialties: { Orthopaedics: "First recommendation" }
};
const multipleRecommendations = {
  cwcAlignment: "YES",
  cwcSpecialties: {
    Nephrology: "First recommendation\nSecond recommendation\nThird recommendation"
  }
};
const multipleSpecialties = {
  cwcAlignment: { displayValue: "Yes" },
  cwcSpecialties: {
    "Specialty A": ["First recommendation", "Second recommendation"],
    "Specialty B": { objectValue: ["Third recommendation"] },
    "Specialty C": "Fourth recommendation"
  }
};

assert.equal(modelFor(oneRecommendation).groups[0].recommendations.length, 1);
assert.equal(modelFor(multipleRecommendations).groups[0].recommendations.length, 3);
assert.equal(modelFor(multipleSpecialties).groups.length, 3);
assert.equal(
  modelFor(multipleSpecialties).groups.reduce(
    (total, group) => total + group.recommendations.length,
    0
  ),
  4
);

for (const project of [
  { cwcAlignment: "No", cwcSpecialties: { Nephrology: "Hidden" } },
  { cwcAlignment: "  ", cwcSpecialties: { Nephrology: "Hidden" } },
  {}
]) {
  assert.equal(modelFor(project), null);
  assert.equal(buildSectionHTML(project), "");
}

const yesWithoutRecommendations = {
  cwcAlignment: "Yes",
  cwcSpecialties: { Nephrology: "\n", Cardiology: [] }
};
assert.deepEqual(modelFor(yesWithoutRecommendations).groups, []);
assert.match(buildSectionHTML(yesWithoutRecommendations), /Choosing Wisely Canada alignment/);
assert.doesNotMatch(buildSectionHTML(yesWithoutRecommendations), /cwc-alignment__group-header/);

assert.equal(isAligned(" yEs "), true);
assert.equal(isAligned({ objectValue: ["Yes"] }), true);
assert.equal(isAligned({ displayValue: "No", value: "Yes" }), false);
assert.deepEqual(
  specialtyGroups({
    "Specialty A": { objectValue: ["First", "Second"] },
    "Specialty B": { displayValue: "Third\nFourth" },
    "Specialty C": []
  }).map(group => [group.specialty, group.recommendations.length]),
  [["Specialty A", 2], ["Specialty B", 2]]
);

const escaped = buildSectionHTML({
  cwcAlignment: "Yes",
  cwcSpecialties: { "A < B": "Use <safe> & verified guidance" }
});
assert.match(escaped, /A &lt; B/);
assert.match(escaped, /Use &lt;safe&gt; &amp; verified guidance/);

console.log("CWC alignment scenarios A-G and normalization checks passed.");
