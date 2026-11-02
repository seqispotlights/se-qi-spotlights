(function (root) {
    "use strict";

    function scalarValues(value) {
        if (value === null || value === undefined) return [];

        if (Array.isArray(value)) {
            return value.flatMap(scalarValues);
        }

        if (typeof value === "object") {
            const preferredKeys = ["displayValue", "objectValue", "value", "values", "items"];
            for (const key of preferredKeys) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    const values = scalarValues(value[key]);
                    if (values.length > 0) return values;
                }
            }
            return [];
        }

        return [String(value)];
    }

    function normalizedText(value) {
        return scalarValues(value)
            .map(item => item.trim())
            .filter(Boolean)
            .join("\n");
    }

    function isAligned(value) {
        return normalizedText(value).toLowerCase() === "yes";
    }

    function recommendationValues(value) {
        const seen = new Set();

        return scalarValues(value)
            .flatMap(item => item.split(/\r?\n/))
            .map(item => item.trim())
            .filter(item => {
                if (!item || seen.has(item)) return false;
                seen.add(item);
                return true;
            });
    }

    function specialtyGroups(value) {
        const entries = Array.isArray(value)
            ? value.map(group => [
                group && (group.specialty || group.name || group.header),
                group && (group.recommendations ?? group.value ?? group.objectValue)
            ])
            : value && typeof value === "object"
                ? Object.entries(value)
                : [];

        return entries
            .map(([specialty, recommendations]) => ({
                specialty: normalizedText(specialty),
                recommendations: recommendationValues(recommendations)
            }))
            .filter(group => group.specialty && group.recommendations.length > 0);
    }

    function modelFor(project) {
        if (!project || !isAligned(project.cwcAlignment)) return null;

        return {
            aligned: true,
            groups: specialtyGroups(project.cwcSpecialties)
        };
    }

    function escapeHTML(value) {
        return String(value).replace(/[&<>'"]/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            "\"": "&quot;"
        })[char]);
    }

    function buildSectionHTML(project) {
        const model = modelFor(project);
        if (!model) return "";

        const groupsHTML = model.groups.map(group => {
            const count = group.recommendations.length;
            const label = `${count} recommendation${count === 1 ? "" : "s"}`;
            const items = group.recommendations
                .map(recommendation => `<li>${escapeHTML(recommendation)}</li>`)
                .join("");

            return `
              <div class="cwc-alignment__group">
                <div class="cwc-alignment__group-header">
                  <h4>${escapeHTML(group.specialty)}</h4>
                  <span>${label}</span>
                </div>
                <ol class="cwc-alignment__recommendations" aria-label="${escapeHTML(group.specialty)} recommendations">${items}</ol>
              </div>
            `;
        }).join("");

        return `
          <section class="modal-section cwc-alignment">
            <div class="cwc-alignment__heading-row">
              <h3 class="cwc-alignment__heading">Choosing Wisely Canada alignment</h3>
              <span class="cwc-alignment__badge">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="9"></circle>
                  <path d="m6 10 2.5 2.5L14 7"></path>
                </svg>
                Yes
              </span>
            </div>
            ${groupsHTML ? `<div class="cwc-alignment__groups">${groupsHTML}</div>` : ""}
          </section>
        `;
    }

    root.CWCAlignment = {
        buildSectionHTML,
        isAligned,
        modelFor,
        normalizedText,
        recommendationValues,
        specialtyGroups
    };
})(globalThis);
