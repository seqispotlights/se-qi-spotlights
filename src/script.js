/* =========================================
   SE-QI Toolkit Project Gallery
   Project loading, faceted filtering, search, cards, and detail views.
   Sustainability taxonomy is loaded from data/sustainability-taxonomy.json.
   ========================================= */

let PROJECTS = [];
let REGULAR_PROJECTS = [];
let INITIATIVES = [];
let SUSTAINABILITY_TAXONOMY = null;
let searchQuery = "";

let activeFilters = {
    province: new Set(),
    sustainabilityPrinciples: new Set(),
    opportunityCategories: new Set(),
    opportunityDetails: new Set()
};

function opportunityDetailToken(categoryKey, value) {
    return JSON.stringify([categoryKey, value]);
}

function parseOpportunityDetailToken(token) {
    try {
        const parsed = JSON.parse(token);
        return Array.isArray(parsed) && parsed.length === 2 ? parsed : [];
    } catch (_error) {
        return [];
    }
}

function setProjectData(projects) {
    PROJECTS = projects.filter((project, index) => {
        const isValidRecord =
            project &&
            typeof project === "object" &&
            (project.type === "project" || project.type === "initiative") &&
            typeof project.title === "string" &&
            project.title.trim() !== "";

        if (!isValidRecord) {
            console.warn("Skipping invalid project record at index " + index + ".");
        }

        return isValidRecord;
    });
    REGULAR_PROJECTS = PROJECTS.filter(project => project.type !== "initiative");
    INITIATIVES = PROJECTS.filter(project => project.type === "initiative");
}

function previewModeEnabled() {
    return new URLSearchParams(window.location.search).get("preview") === "1";
}

async function fetchJson(path, label) {
    const response = await fetch(path, { cache: "no-cache" });

    if (!response.ok) {
        throw new Error(label + " request failed with status " + response.status);
    }

    return response.json();
}

async function loadProjectData() {
    const path = previewModeEnabled() ? "data/projects.preview.json" : "data/projects.json";
    const projects = await fetchJson(path, path);

    if (!Array.isArray(projects)) {
        throw new Error(path + " must contain an array of project records");
    }

    return projects;
}

async function loadSustainabilityTaxonomy() {
    const taxonomy = await fetchJson(
        "data/sustainability-taxonomy.json",
        "sustainability taxonomy"
    );

    if (
        !taxonomy ||
        !taxonomy.principles ||
        !Array.isArray(taxonomy.principles.values) ||
        !Array.isArray(taxonomy.opportunities)
    ) {
        throw new Error("sustainability-taxonomy.json has an invalid structure");
    }

    return taxonomy;
}

function showProjectLoadError(error) {
    console.error("Could not load project data:", error);

    const grid = document.getElementById("projectGrid");
    const initiativeGrid = document.getElementById("initiativeGrid");
    const emptyState = document.getElementById("emptyState");
    const countEl = document.getElementById("projectCount");

    if (grid) grid.innerHTML = "";
    if (initiativeGrid) initiativeGrid.innerHTML = "";
    if (countEl) countEl.textContent = "Content unavailable";

    if (!emptyState) return;

    emptyState.style.display = "flex";
    emptyState.replaceChildren();

    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "!";

    const heading = document.createElement("h3");
    heading.textContent = "Project content could not be loaded";

    const message = document.createElement("p");
    message.textContent = "Please refresh the page or check that the project data is available.";

    emptyState.append(icon, heading, message);
}

function setAccordionExpanded(button, panel, expanded) {
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    panel.hidden = !expanded;
}

function createAccordionSection(id, label) {
    const section = document.createElement("section");
    section.className = "filter-group";

    const heading = document.createElement("h3");
    heading.className = "filter-group-heading";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "filter-group-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", id);

    const chevron = document.createElement("span");
    chevron.className = "filter-chevron";
    chevron.setAttribute("aria-hidden", "true");

    const labelText = document.createElement("span");
    labelText.className = "filter-group-label";
    labelText.textContent = label;

    const count = document.createElement("span");
    count.className = "filter-group-count";
    count.dataset.filterCountFor = id;
    count.hidden = true;

    toggle.append(chevron, labelText, count);
    heading.appendChild(toggle);

    const panel = document.createElement("div");
    panel.id = id;
    panel.className = "filter-group-panel";
    panel.hidden = true;

    toggle.addEventListener("click", () => {
        setAccordionExpanded(toggle, panel, toggle.getAttribute("aria-expanded") !== "true");
    });

    section.append(heading, panel);
    return { section, panel };
}

function createFilterCheckbox({ labelText, value, dataset, className = "" }) {
    const label = document.createElement("label");
    label.className = ["filter-checkbox-label", className].filter(Boolean).join(" ");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "filter-checkbox";
    input.value = value;

    for (const [key, datasetValue] of Object.entries(dataset)) {
        input.dataset[key] = datasetValue;
    }

    input.addEventListener("change", onFilterChange);

    const text = document.createElement("span");
    text.className = "filter-checkbox-text";
    text.textContent = labelText;

    label.append(input, text);
    return label;
}

function buildStandardFilterPanel(panel, field, values) {
    for (const value of values) {
        panel.appendChild(
            createFilterCheckbox({
                labelText: value,
                value,
                dataset: { filterKind: "standard", field }
            })
        );
    }
}

function buildOpportunityFilterPanel(panel) {
    for (const category of SUSTAINABILITY_TAXONOMY.opportunities) {
        const categorySection = document.createElement("div");
        categorySection.className = "opportunity-filter-category";

        const categoryRow = document.createElement("div");
        categoryRow.className = "opportunity-filter-category-row";

        const parentLabel = document.createElement("span");
        parentLabel.className = "opportunity-parent-label";
        parentLabel.textContent = category.label;

        const childPanelId = "opportunity-" + category.key;
        const childToggle = document.createElement("button");
        childToggle.type = "button";
        childToggle.className = "opportunity-category-toggle";
        childToggle.setAttribute("aria-expanded", "false");
        childToggle.setAttribute("aria-controls", childPanelId);
        childToggle.setAttribute("aria-label", "Expand " + category.label + " opportunities");
        childToggle.title = "Expand " + category.label + " opportunities";

        const childChevron = document.createElement("span");
        childChevron.className = "filter-chevron";
        childChevron.setAttribute("aria-hidden", "true");
        childToggle.appendChild(childChevron);

        const childPanel = document.createElement("div");
        childPanel.id = childPanelId;
        childPanel.className = "opportunity-filter-children";
        childPanel.hidden = true;

        for (const value of category.values) {
            childPanel.appendChild(
                createFilterCheckbox({
                    labelText: value,
                    value,
                    dataset: {
                        filterKind: "opportunityDetail",
                        categoryKey: category.key
                    },
                    className: "opportunity-child-label"
                })
            );
        }

        childToggle.addEventListener("click", () => {
            const expanded = childToggle.getAttribute("aria-expanded") !== "true";
            setAccordionExpanded(childToggle, childPanel, expanded);
            childToggle.setAttribute(
                "aria-label",
                (expanded ? "Collapse " : "Expand ") + category.label + " opportunities"
            );
            childToggle.title =
                (expanded ? "Collapse " : "Expand ") + category.label + " opportunities";
        });

        categoryRow.append(parentLabel, childToggle);
        categorySection.append(categoryRow, childPanel);
        panel.appendChild(categorySection);
    }
}

function buildFilters() {
    const sidebar = document.getElementById("filterSidebar");
    if (!sidebar || !SUSTAINABILITY_TAXONOMY) return;

    sidebar.innerHTML = "";

    const provinces = [...new Set(
        PROJECTS.map(project => String(project.province || "").trim()).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    const provinceGroup = createAccordionSection("province-filter-panel", "Province / Territory");
    buildStandardFilterPanel(provinceGroup.panel, "province", provinces);

    const principlesGroup = createAccordionSection(
        "principles-filter-panel",
        "Sustainability Principles"
    );
    buildStandardFilterPanel(
        principlesGroup.panel,
        "sustainabilityPrinciples",
        SUSTAINABILITY_TAXONOMY.principles.values
    );

    const opportunitiesGroup = createAccordionSection(
        "opportunities-filter-panel",
        "Sustainability Opportunities"
    );
    buildOpportunityFilterPanel(opportunitiesGroup.panel);

    sidebar.append(
        provinceGroup.section,
        principlesGroup.section,
        opportunitiesGroup.section
    );
}

function onFilterChange(event) {
    const input = event.currentTarget || event.target;
    const kind = input.dataset.filterKind;

    if (kind === "standard") {
        const values = activeFilters[input.dataset.field];
        if (!values) return;
        input.checked ? values.add(input.value) : values.delete(input.value);
    } else if (kind === "opportunityCategory") {
        input.checked
            ? activeFilters.opportunityCategories.add(input.dataset.categoryKey)
            : activeFilters.opportunityCategories.delete(input.dataset.categoryKey);
    } else if (kind === "opportunityDetail") {
        const token = opportunityDetailToken(input.dataset.categoryKey, input.value);
        input.checked
            ? activeFilters.opportunityDetails.add(token)
            : activeFilters.opportunityDetails.delete(token);
    } else {
        return;
    }

    renderProjects();
    renderInitiatives();
    updateActiveCount();
}

function projectMatchesSearch(project) {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return true;

    const opportunityValues = [];
    const opportunityComments = [];
    const opportunityCategoryLabels = [];
    const projectOpportunities = project.sustainabilityOpportunities || {};
    const projectOpportunityComments = project.sustainabilityOpportunityComments || {};

    for (const category of SUSTAINABILITY_TAXONOMY?.opportunities || []) {
        const values = projectOpportunities[category.key];
        const comment = projectOpportunityComments[category.key];
        const hasValues = Array.isArray(values) && values.length > 0;
        const hasComment = comment !== null && comment !== undefined && String(comment).trim() !== "";

        if (hasValues || hasComment) {
            opportunityCategoryLabels.push(category.label);
        }

        if (hasValues) {
            opportunityValues.push(...values);
        }

        if (hasComment) {
            opportunityComments.push(comment);
        }
    }

    const domainValues = (project.domainsOfQuality || []).flatMap(item => [
        item && item.name,
        item && item.explanation
    ]);
    const metricValues = Object.values(project.metrics || {}).flatMap(values =>
        Array.isArray(values) ? values : []
    );

    const searchable = [
        project.title,
        project.description,
        project.organization,
        project.department,
        project.province,
        project.healthcareSetting,
        project.stage,
        project.initiativeStage,
        project.toolkitApplication,
        project.toolkitAudienceUptake,
        project.mostValuableElements,
        project.qiIntegrationComments,
        project.cobenefit,
        ...(project.sustainabilityPrinciples || []),
        ...opportunityCategoryLabels,
        ...opportunityValues,
        ...opportunityComments,
        ...domainValues,
        ...metricValues
    ]
        .filter(value => value !== null && value !== undefined)
        .join(" ")
        .toLocaleLowerCase();

    return searchable.includes(query);
}

function projectMatchesFilters(project) {
    if (!projectMatchesSearch(project)) return false;

    if (
        activeFilters.province.size > 0 &&
        !activeFilters.province.has(project.province)
    ) {
        return false;
    }

    if (activeFilters.sustainabilityPrinciples.size > 0) {
        const projectPrinciples = Array.isArray(project.sustainabilityPrinciples)
            ? project.sustainabilityPrinciples
            : [];
        const matchesPrinciple = [...activeFilters.sustainabilityPrinciples].some(value =>
            projectPrinciples.includes(value)
        );
        if (!matchesPrinciple) return false;
    }

    if (
        activeFilters.opportunityCategories.size > 0 ||
        activeFilters.opportunityDetails.size > 0
    ) {
        const projectOpportunities =
            project.sustainabilityOpportunities &&
            typeof project.sustainabilityOpportunities === "object" &&
            !Array.isArray(project.sustainabilityOpportunities)
                ? project.sustainabilityOpportunities
                : {};

        const matchesParent = [...activeFilters.opportunityCategories].some(categoryKey => {
            const values = projectOpportunities[categoryKey];
            return Array.isArray(values) && values.length > 0;
        });
        const matchesChild = [...activeFilters.opportunityDetails].some(token => {
            const [categoryKey, value] = parseOpportunityDetailToken(token);
            const values = projectOpportunities[categoryKey];
            return Array.isArray(values) && values.includes(value);
        });

        if (!matchesParent && !matchesChild) return false;
    }

    return true;
}

function renderProjects() {
    const grid = document.getElementById("projectGrid");
    const emptyState = document.getElementById("emptyState");
    const countEl = document.getElementById("projectCount");
    if (!grid) return;

    const visibleProjects = REGULAR_PROJECTS.filter(projectMatchesFilters);
    grid.innerHTML = "";

    if (visibleProjects.length === 0) {
        if (emptyState) emptyState.style.display = "flex";
    } else {
        if (emptyState) emptyState.style.display = "none";
        visibleProjects.forEach((project, index) => {
            grid.appendChild(buildTile(project, index));
        });
    }

    if (countEl) {
        countEl.textContent = visibleProjects.length + " of " + REGULAR_PROJECTS.length;
    }
}

function renderInitiatives() {
    const grid = document.getElementById("initiativeGrid");
    const section = document.getElementById("initiativesSection");
    const countEl = document.getElementById("initiativeCount");
    if (!grid) return;

    const visibleInitiatives = INITIATIVES.filter(projectMatchesFilters);
    grid.innerHTML = "";

    if (section) {
        section.style.display = visibleInitiatives.length === 0 ? "none" : "";
    }

    visibleInitiatives.forEach((initiative, index) => {
        grid.appendChild(buildTile(initiative, index));
    });

    if (countEl) {
        countEl.textContent = visibleInitiatives.length + " of " + INITIATIVES.length;
    }
}

function getStageClass(stage) {
    if (!stage) return "stage-unknown";

    const normalized = stage.toLowerCase();

    if (normalized.includes("not started")) {
        return "stage-not-started";
    }

    if (normalized.includes("work in progress")) {
        return "stage-progress";
    }

    if (normalized.includes("complete")) {
        return "stage-complete";
    }

    return "stage-unknown";
}

function buildStageBadge(stage) {
    if (!stage) return "";

    return `
    <span class="stage-badge ${getStageClass(stage)}">
      ${escapeHTML(stage)}
    </span>
  `;
}

function buildMailLink(project) {
    if (!project.email || !project.contactName) return "";

    return `
      <a href="mailto:${escapeHTML(project.email)}" class="contact-button">
        Email ${escapeHTML(project.contactName)}
      </a>
    `;
}

const RESOURCE_SECTION_LABEL_RE =
    /(Valuable Resources:|Resources identified as particularly valuable:)/i;
const URL_RE = /https?:\/\/[^\s<>"'\]\)]+/gi;
const HAS_URL_RE = /https?:\/\/[^\s<>"'\]\)]+/i;

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function decodeHTMLEntities(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
}

function stripHTMLTags(value) {
    return value.replace(/<[^>]*>/g, "");
}

function normalizeToolkitText(value) {
    return decodeHTMLEntities(
        String(value ?? "")
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, href) => {
                const cleanLabel = stripHTMLTags(label).trim();
                return /^https?:\/\//i.test(cleanLabel) ? href : `${cleanLabel} ${href}`;
            })
            .replace(
                /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
                (_match, _quote, href, label) => `${stripHTMLTags(label)} ${href}`
            )
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|li|ul|ol|strong|b)>/gi, "\n")
            .replace(/<(p|div|li|ul|ol|strong|b)\b[^>]*>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .replace(/\r\n?/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
    );
}

function cleanResourceTitle(value) {
    return String(value ?? "")
        .replace(/^[\s;:\-*]+/, "")
        .replace(/^\d+[\).]\s*/, "")
        .replace(/[\s:;\-]+$/, "")
        .trim();
}

function normalizeURL(value) {
    const url = String(value ?? "")
        .trim()
        .replace(/^[\[(<]+/, "")
        .replace(/[\])>`]+$/, "");

    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch (_error) {
        return "";
    }
}

function extractFirstURL(value) {
    const match = String(value ?? "").match(HAS_URL_RE);
    return match ? match[0] : "";
}

function removeURLFromText(value, url) {
    if (!url) return value;
    return String(value ?? "").replace(url, "");
}

function isURLOnlyLine(value) {
    const text = cleanResourceTitle(value);
    const url = extractFirstURL(text);
    if (!url) return false;

    return cleanResourceTitle(removeURLFromText(text, url).replace(/[\[\]()]/g, "")) === "";
}

function buildResourceLink(url, title) {
    const safeURL = normalizeURL(url);
    if (!safeURL) {
        return escapeHTML(`${title ? `${title} ` : ""}${url}`.trim());
    }

    const linkText = cleanResourceTitle(title) || safeURL;
    return `<a class="toolkit-resource-link" href="${escapeHTML(safeURL)}" target="_blank" rel="noopener noreferrer">${escapeHTML(linkText)}</a>`;
}

function splitPlainResourceItems(value) {
    return String(value ?? "")
        .split(/\s*;\s*|\n+/)
        .map(item => cleanResourceTitle(item))
        .filter(Boolean);
}

function splitResourceLines(value) {
    return String(value ?? "")
        .split(/\s*;\s*|\n+/)
        .map(item => cleanResourceTitle(item))
        .filter(Boolean);
}

function parseLinkedResources(value) {
    const lines = splitResourceLines(value);

    if (!lines.some(line => HAS_URL_RE.test(line))) {
        return splitPlainResourceItems(value).map(item => ({
            title: item,
            url: ""
        }));
    }

    const resources = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const nextLine = lines[index + 1] || "";
        const inlineURL = extractFirstURL(line);

        if (!inlineURL && nextLine && isURLOnlyLine(nextLine)) {
            resources.push({
                title: line,
                url: extractFirstURL(nextLine)
            });
            index += 1;
            continue;
        }

        if (!inlineURL) {
            resources.push({
                title: line,
                url: ""
            });
            continue;
        }

        const title = cleanResourceTitle(removeURLFromText(line, inlineURL));
        resources.push({
            title: title || normalizeURL(inlineURL) || inlineURL,
            url: inlineURL
        });
    }

    return resources;
}

function formatPlainParagraphs(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";

    return text
        .split(/\n{2,}/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean)
        .map(paragraph => `<p>${paragraph.split(/\n/).map(escapeHTML).join("<br>")}</p>`)
        .join("");
}

function autoLinkText(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";

    return text
        .split(/\n{2,}/)
        .map(paragraph => {
            let html = "";
            let previousEnd = 0;

            URL_RE.lastIndex = 0;
            for (const match of paragraph.matchAll(URL_RE)) {
                html += escapeHTML(paragraph.slice(previousEnd, match.index));
                html += buildResourceLink(match[0], "");
                previousEnd = match.index + match[0].length;
            }

            html += escapeHTML(paragraph.slice(previousEnd));
            return `<p>${html.replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
}

function formatToolkitResources(value) {
    const normalizedText = normalizeToolkitText(value);
    if (!normalizedText) return "";

    const labelMatch = normalizedText.match(RESOURCE_SECTION_LABEL_RE);
    if (!labelMatch) {
        if (!HAS_URL_RE.test(normalizedText)) {
            return formatPlainParagraphs(normalizedText);
        }

        const resources = parseLinkedResources(normalizedText);
        const hasTitledResource = resources.some(resource => resource.url && resource.title !== normalizeURL(resource.url));
        if (hasTitledResource) {
            const resourceItemsHTML = resources
                .map(resource => {
                    const content = resource.url
                        ? buildResourceLink(resource.url, resource.title)
                        : escapeHTML(resource.title);
                    return `<li>${content}</li>`;
                })
                .join("");
            return `<ul class="toolkit-resource-list">${resourceItemsHTML}</ul>`;
        }

        return autoLinkText(normalizedText);
    }

    URL_RE.lastIndex = 0;
    const labelStart = labelMatch.index;
    const labelEnd = labelStart + labelMatch[0].length;
    const introText = normalizedText.slice(0, labelStart).trim();
    const resourceText = normalizedText.slice(labelEnd).trim();
    const resources = parseLinkedResources(resourceText);

    if (resources.length === 0) {
        return autoLinkText(normalizedText);
    }

    const introHTML = formatPlainParagraphs(introText);
    const resourceItemsHTML = resources
        .map(resource => {
            const content = resource.url
                ? buildResourceLink(resource.url, resource.title)
                : escapeHTML(resource.title);
            return `<li>${content}</li>`;
        })
        .join("");

    return `
        ${introHTML}
        <p class="toolkit-resource-heading"><strong>Resources identified as particularly valuable:</strong></p>
        <ul class="toolkit-resource-list">${resourceItemsHTML}</ul>
    `;
}



/* =========================================
 TILE BEAUTIFY — replace your existing buildTile()
 function in script.js with this one.
 Everything else in script.js stays the same.
 ========================================= */

function buildPrincipleTagsHTML(principles, className = "") {
    return (Array.isArray(principles) ? principles : [])
        .filter(hasText)
        .map(tag => {
            const cleanTag = String(tag).trim();
            const classes = ["tag", className].filter(Boolean).join(" ");
            return `<span class="${classes}" data-principle="${escapeHTML(cleanTag)}">${escapeHTML(cleanTag)}</span>`;
        })
        .join("");
}

function buildTile(project, index) {
    const article = document.createElement("article");
    const isInitiative = project.type === "initiative";

    article.className = isInitiative ? "project-tile initiative-tile" : "project-tile";
    article.setAttribute("tabindex", "0");
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", "View details for " + project.title);
    article.style.animationDelay = index * 0.07 + "s";

    if (isInitiative) {
        article.dataset.type = "initiative";
    } else if (project.sustainabilityPrinciples && project.sustainabilityPrinciples[0]) {
        article.dataset.principle = project.sustainabilityPrinciples[0];
    }

    const imgWrap = document.createElement("div");
    imgWrap.className = "tile-image";

    if (project.photo) {
        const img = document.createElement("img");
        img.src = project.photo;
        img.alt = project.photoAlt || project.title;
        img.loading = "lazy";
        img.addEventListener("error", () => {
            imgWrap.classList.add("tile-image--placeholder");
            imgWrap.innerHTML = placeholderSVG(project.id || project.title);
        }, { once: true });
        imgWrap.appendChild(img);
    } else {
        imgWrap.classList.add("tile-image--placeholder");
        imgWrap.innerHTML = placeholderSVG(project.id);
    }

    const footer = document.createElement("div");
    footer.className = "tile-footer";

    if (isInitiative) {
        const label = document.createElement("span");
        label.className = "tile-type-label";
        label.textContent = "Training & Capacity Building";
        footer.appendChild(label);
    }

    const titleEl = document.createElement("h2");
    titleEl.className = "tile-title";
    titleEl.textContent = project.title;
    footer.appendChild(titleEl);

    article.appendChild(imgWrap);
    article.appendChild(footer);

    article.addEventListener("click", () => openModal(project));
    article.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openModal(project);
        }
    });

    return article;
}

function placeholderSVG(id) {
    const palettes = [
        { bg: "#d4f2ee", icon: "#1a7a6e" },
        { bg: "#dcf5e7", icon: "#2d7d4e" },
        { bg: "#dbeafe", icon: "#2563eb" },
        { bg: "#ede9fe", icon: "#7c3aed" },
        { bg: "#fef9c3", icon: "#ca8a04" },
        { bg: "#ffedd5", icon: "#ea580c" }
    ];
    const seed = [...String(id ?? "")]
        .reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 0);
    const p = palettes[seed % palettes.length];

    return `
    <div class="placeholder-graphic" style="background:${p.bg}">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="6" y="10" width="36" height="28" rx="4" stroke="${p.icon}" stroke-width="2"/>
        <circle cx="16" cy="20" r="4" stroke="${p.icon}" stroke-width="2"/>
        <path d="M6 34l10-10 8 8 6-6 12 8" stroke="${p.icon}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span style="color:${p.icon}">Photo Coming Soon</span>
    </div>`;
}

function openModal(project) {
    const overlay = document.getElementById("modalOverlay");
    const body = document.getElementById("modalBody");
    if (!overlay || !body) return;

    body.innerHTML = buildModalHTML(project);

    const modalImage = body.querySelector("img.modal-photo");
    modalImage?.addEventListener("error", () => {
        const imageWrap = modalImage.closest(".modal-photo-wrap");
        if (!imageWrap) return;

        imageWrap.classList.add("modal-photo-wrap--placeholder");
        imageWrap.innerHTML = `
            <div class="modal-photo modal-photo--placeholder">
                ${placeholderSVG(project.id || project.title)}
            </div>
        `;
    }, { once: true });

    overlay.classList.add("modal--open");
    document.body.classList.add("modal-active");

    const closeBtn = overlay.querySelector(".modal-close");
    if (closeBtn) closeBtn.focus();
}

function closeModal() {
    const overlay = document.getElementById("modalOverlay");
    if (!overlay) return;

    overlay.classList.remove("modal--open");
    document.body.classList.remove("modal-active");
}
const INFO_PANEL_ICONS = {
    building: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 21V7.5L12 3l8 4.5V21" />
      <path d="M9 21v-6h6v6" />
      <path d="M8 10h.01M12 10h.01M16 10h.01M8 13h.01M16 13h.01" />
    </svg>
  `,
    people: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 11a4 4 0 1 0-8 0" />
      <path d="M6 21v-2a6 6 0 0 1 12 0v2" />
      <path d="M18 8a3 3 0 0 1 3 3" />
      <path d="M21 21v-1a5 5 0 0 0-3-4.5" />
      <path d="M6 8a3 3 0 0 0-3 3" />
      <path d="M3 21v-1a5 5 0 0 1 3-4.5" />
    </svg>
  `,
    hospital: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" />
      <path d="M9 21v-5h6v5" />
      <path d="M12 7v5" />
      <path d="M9.5 9.5h5" />
      <path d="M7.5 14h.01M16.5 14h.01" />
    </svg>
  `,
    mapPin: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s7-5.4 7-12a7 7 0 1 0-14 0c0 6.6 7 12 7 12Z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  `,
    calendar: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" />
    </svg>
  `
};

function hasText(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
}

function textWithLineBreaks(value) {
    return escapeHTML(String(value).trim()).replace(/\r?\n/g, "<br>");
}

function buildModalSection(heading, contentHTML, sectionClass = "") {
    if (!contentHTML) return "";

    const className = `modal-section${sectionClass ? ` ${sectionClass}` : ""}`;
    return `
      <section class="${className}">
        <h3 class="modal-section-heading">${escapeHTML(heading)}</h3>
        ${contentHTML}
      </section>
    `;
}

function buildPlainTextSection(heading, value) {
    if (!hasText(value)) return "";
    return buildModalSection(heading, `<p>${textWithLineBreaks(value)}</p>`);
}

function buildToolkitSection(heading, value) {
    const content = formatToolkitResources(value);
    if (!content) return "";
    return buildModalSection(heading, `<div class="cobenefit-text">${content}</div>`);
}

function buildLearnMoreSection(project) {
    const mailLink = buildMailLink(project);
    if (!mailLink) return "";

    return buildModalSection(
        "Learn More",
        `<p>
          For questions about this initiative or to connect with the project team, use the email link below.
        </p>
        ${mailLink}`,
        "learn-more-section"
    );
}

function buildInfoItem(icon, label, value) {
    if (!hasText(value)) return "";

    return `
    <div class="info-panel-row">
      <div class="info-panel-icon" aria-hidden="true">${icon}</div>
      <div class="info-panel-copy">
        <span class="info-panel-label">${escapeHTML(label)}</span>
        <span class="info-panel-value">${escapeHTML(String(value).trim())}</span>
      </div>
    </div>
  `;
}

function buildProjectInfoPanel(p) {
    const stageValue = buildStageBadge(p.stage || p.initiativeStage);
    const thirdItem = p.type === "initiative"
        ? buildInfoItem(INFO_PANEL_ICONS.hospital, "Initiative Type", "Training & Capacity Building")
        : buildInfoItem(INFO_PANEL_ICONS.hospital, "Healthcare Setting", p.healthcareSetting);

    return `
    <section class="info-panel">
      <div class="info-panel-header">
        <div class="info-panel-title-wrap">
          <h2 class="info-panel-title">${escapeHTML(p.title)}</h2>
        </div>
        ${stageValue}
      </div>

      <div class="info-panel-list">
          ${buildInfoItem(INFO_PANEL_ICONS.building, "Organization", p.organization)}
          ${buildInfoItem(INFO_PANEL_ICONS.people, "Department", p.department)}
          ${thirdItem}
          ${buildInfoItem(INFO_PANEL_ICONS.mapPin, "Province / Territory", p.province)}
          ${buildInfoItem(INFO_PANEL_ICONS.calendar, "Published On", p.publishedOn)}
      </div>
    </section>
  `;
}

function buildDetailItems(items) {
    if (!Array.isArray(items)) return "";

    return items
        .filter(item => item && hasText(item.name))
        .map(item => {
            const explanation = hasText(item.explanation)
                ? `<p class="detail-item-desc">${textWithLineBreaks(item.explanation)}</p>`
                : "";

            return `
              <div class="detail-item">
                <span class="detail-item-name">${escapeHTML(String(item.name).trim())}</span>
                ${explanation}
              </div>
            `;
        })
        .join("");
}

function buildSustainabilityOpportunityItems(project) {
    if (!SUSTAINABILITY_TAXONOMY) return "";

    const opportunities = project.sustainabilityOpportunities || {};
    const comments = project.sustainabilityOpportunityComments || {};

    return SUSTAINABILITY_TAXONOMY.opportunities
        .map(category => {
            const values = Array.isArray(opportunities[category.key])
                ? opportunities[category.key].filter(hasText)
                : [];
            const hasComment = hasText(comments[category.key]);
            if (values.length === 0 && !hasComment) return "";

            const commentHTML = hasComment
                ? `<p class="opportunity-comment">${textWithLineBreaks(comments[category.key])}</p>`
                : "";
            const valuesHTML = values.length > 0
                ? `<div class="opportunity-selected">
                    <div class="opportunity-chip-row">
                      ${values.map(value => `<span class="opportunity-chip">${escapeHTML(String(value).trim())}</span>`).join("")}
                    </div>
                  </div>`
                : "";

            return `
              <div class="detail-item opportunity-detail-item">
                <span class="detail-item-name">${escapeHTML(category.label)}</span>
                ${commentHTML}
                ${valuesHTML}
              </div>
            `;
        })
        .join("");
}

function buildMetricColumn(label, modifier, metrics) {
    if (!Array.isArray(metrics)) return "";

    const items = metrics
        .filter(hasText)
        .map(metric => `<li>${textWithLineBreaks(metric)}</li>`)
        .join("");
    if (!items) return "";

    return `
      <div class="metrics-col">
        <h4 class="metrics-col-heading metrics-col-heading--${modifier}">${escapeHTML(label)}</h4>
        <ul class="metrics-list metrics-list--${modifier}">${items}</ul>
      </div>
    `;
}

function buildModalHTML(p) {
    const photoHTML = hasText(p.photo)
        ? `<div class="modal-photo-wrap">
         <img class="modal-photo" src="${escapeHTML(p.photo)}" alt="${escapeHTML(p.photoAlt || p.title)}" />
         <div class="modal-photo-gradient"></div>
       </div>`
        : `<div class="modal-photo-wrap modal-photo-wrap--placeholder">
         <div class="modal-photo modal-photo--placeholder">${placeholderSVG(p.id || p.title)}</div>
       </div>`;

    if (p.type === "initiative") {
        return `
      ${photoHTML}
      <div class="modal-content-body modal-content-body--initiative">
        ${buildProjectInfoPanel(p)}
        ${buildPlainTextSection("Initiative Description", p.description)}
        ${buildPlainTextSection("Toolkit Application", p.toolkitApplication)}
        ${buildPlainTextSection("Toolkit Audience & Uptake", p.toolkitAudienceUptake)}
        ${buildToolkitSection("Most Valuable Toolkit Elements", p.mostValuableElements)}
        ${buildLearnMoreSection(p)}
      </div>
    `;
    }

    const principleTagsHTML = buildPrincipleTagsHTML(p.sustainabilityPrinciples, "tag--teal");
    const principlesSection = principleTagsHTML
        ? buildModalSection("Sustainability Principles", `<div class="tag-row">${principleTagsHTML}</div>`)
        : "";

    const opportunitiesHTML = buildSustainabilityOpportunityItems(p);
    const opportunitiesSection = opportunitiesHTML
        ? buildModalSection("Sustainability Opportunities", `<div class="detail-list">${opportunitiesHTML}</div>`)
        : "";

    const environmentalMetrics = buildMetricColumn(
        "Environmental",
        "env",
        p.metrics && p.metrics.environmental
    );
    const activityMetrics = buildMetricColumn(
        "Activity",
        "act",
        p.metrics && p.metrics.activity
    );
    const metricsHTML = `${environmentalMetrics}${activityMetrics}`;
    const metricsSection = metricsHTML
        ? buildModalSection("Metrics", `<div class="metrics-grid">${metricsHTML}</div>`)
        : "";

    const domainsHTML = buildDetailItems(p.domainsOfQuality);
    const domainsSection = domainsHTML
        ? buildModalSection("Domains of Quality", `<div class="detail-list">${domainsHTML}</div>`)
        : "";

    return `
    ${photoHTML}
    <div class="modal-content-body">
      ${buildProjectInfoPanel(p)}
      ${buildPlainTextSection("Project Description", p.description)}
      ${principlesSection}
      ${opportunitiesSection}
      ${metricsSection}
      ${domainsSection}
      ${buildToolkitSection("Most Valuable SE-QI Toolkit Resources", p.cobenefit)}
      ${buildLearnMoreSection(p)}
    </div>
  `;
}


    
function updateActiveCount() {
    const total =
        activeFilters.province.size +
        activeFilters.sustainabilityPrinciples.size +
        activeFilters.opportunityCategories.size +
        activeFilters.opportunityDetails.size;

    const badge = document.getElementById("filterBadge");
    const clearBtn = document.getElementById("clearFilters");
    const sidebarToggle = document.getElementById("sidebarToggle");

    if (badge) {
        badge.dataset.count = total;
        badge.textContent = total;
    }
    if (clearBtn) {
        clearBtn.classList.toggle("btn-clear--visible", total > 0);
    }
    if (sidebarToggle) {
        sidebarToggle.setAttribute("aria-expanded",
            document.body.classList.contains("sidebar-active") ? "true" : "false");
    }

    updateFilterSectionCount("province-filter-panel", activeFilters.province.size);
    updateFilterSectionCount(
        "principles-filter-panel",
        activeFilters.sustainabilityPrinciples.size
    );
    updateFilterSectionCount(
        "opportunities-filter-panel",
        activeFilters.opportunityCategories.size + activeFilters.opportunityDetails.size
    );
}

function updateFilterSectionCount(panelId, count) {
    const countElement = document.querySelector?.(
        `[data-filter-count-for="${panelId}"]`
    );
    if (!countElement) return;

    countElement.textContent = String(count);
    countElement.hidden = count === 0;
}

function updateSearchClearButton() {
    const clearButton = document.getElementById("clearSearch");
    if (clearButton) clearButton.hidden = searchQuery === "";
}

function onSearchInput(event) {
    searchQuery = String(event.target.value || "").trimStart();
    updateSearchClearButton();
    renderProjects();
    renderInitiatives();
}

function clearSearch() {
    searchQuery = "";
    const searchInput = document.getElementById("projectSearch");
    if (searchInput) searchInput.value = "";
    updateSearchClearButton();
    renderProjects();
    renderInitiatives();
}

function clearAllFilters() {
    activeFilters.province.clear();
    activeFilters.sustainabilityPrinciples.clear();
    activeFilters.opportunityCategories.clear();
    activeFilters.opportunityDetails.clear();
    document.querySelectorAll(".filter-checkbox").forEach(cb => { cb.checked = false; });
    renderProjects();
    renderInitiatives();
    updateActiveCount();
}

function clearSearchAndFilters() {
    searchQuery = "";
    const searchInput = document.getElementById("projectSearch");
    if (searchInput) searchInput.value = "";
    updateSearchClearButton();
    clearAllFilters();
}

function setSidebarOpen(isOpen) {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebarOverlay");
    const toggle = document.getElementById("sidebarToggle");
    const closeBtn = document.getElementById("sidebarClose");

    sidebar && sidebar.classList.toggle("sidebar--open", isOpen);
    overlay && overlay.classList.toggle("sidebar-overlay--open", isOpen);
    overlay && overlay.setAttribute("aria-hidden", isOpen ? "false" : "true");
    document.body.classList.toggle("sidebar-active", isOpen);

    if (toggle) {
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        if (!isOpen) toggle.focus();
    }
    if (isOpen && closeBtn) closeBtn.focus();
}

function toggleSidebar() {
    setSidebarOpen(!document.body.classList.contains("sidebar-active"));
}

function closeSidebar() {
    setSidebarOpen(false);
}

function bindGalleryEvents() {
    document.getElementById("modalClose")?.addEventListener("click", closeModal);
    document.getElementById("modalOverlay")?.addEventListener("click", e => {
        if (e.target === e.currentTarget) closeModal();
    });

    document.getElementById("clearFilters")?.addEventListener("click", clearAllFilters);
    document.getElementById("clearAllEmpty")?.addEventListener("click", clearSearchAndFilters);
    document.getElementById("projectSearch")?.addEventListener("input", onSearchInput);
    document.getElementById("clearSearch")?.addEventListener("click", clearSearch);

    document.getElementById("sidebarToggle")?.addEventListener("click", toggleSidebar);
    document.getElementById("sidebarClose")?.addEventListener("click", closeSidebar);
    document.getElementById("sidebarOverlay")?.addEventListener("click", closeSidebar);

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && document.body.classList.contains("sidebar-active")) {
            closeSidebar();
            return;
        }
        if (e.key === "Escape") closeModal();
    });
}

async function initializeGallery() {
    try {
        const [projects, taxonomy] = await Promise.all([
            loadProjectData(),
            loadSustainabilityTaxonomy()
        ]);
        SUSTAINABILITY_TAXONOMY = taxonomy;
        setProjectData(projects);

        buildFilters();
        renderProjects();
        renderInitiatives();
        updateActiveCount();
        bindGalleryEvents();
    } catch (error) {
        showProjectLoadError(error);
    }
}

document.addEventListener("DOMContentLoaded", initializeGallery);

/* ---- Scroll-to-top button ---- */
(function () {
    const btn = document.getElementById("scrollTopBtn");
    if (!btn) return;

    window.addEventListener("scroll", () => {
        btn.classList.toggle("btn-scroll-top--visible", window.scrollY > 320);
    }, { passive: true });

    btn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
})();
