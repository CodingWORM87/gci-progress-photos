"use strict";

/* ---------- IndexedDB helper ---------- */

const DB_NAME = "gci-progress-photos";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("jobs")) {
        db.createObjectStore("jobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("equipment")) {
        db.createObjectStore("equipment", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("entries")) {
        const store = db.createObjectStore("entries", { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function idbAll(storeName) {
  return tx(storeName, "readonly").then(
    (store) =>
      new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbPut(storeName, value) {
  return tx(storeName, "readwrite").then(
    (store) =>
      new Promise((resolve, reject) => {
        const req = store.put(value);
        req.onsuccess = () => resolve(value);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbDelete(storeName, id) {
  return tx(storeName, "readwrite").then(
    (store) =>
      new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
  );
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Seed data ---------- */

const SEED_FLEET = [
  "953 Track Loader",
  "323F Excavator",
  "770G Motor Grader",
  "SVL75 Track Loader",
  "SVL95 Track Loader",
  "SD75 Roller",
  "4000 Gal Water Truck",
  "6yd Dump Truck",
  "379 Pete - Trucking",
];

async function seedIfEmpty() {
  const equip = await idbAll("equipment");
  if (equip.length === 0) {
    for (const name of SEED_FLEET) {
      await idbPut("equipment", { id: uid(), name, type: "fleet" });
    }
  }
}

/* ---------- App state ---------- */

const state = {
  jobs: [],
  equipment: [],
  entries: [],
  selectedEquipIds: new Set(),
  photoBlob: null,
  location: null,
  activeTab: "capture",
  reportEntries: null,
};

/* ---------- Utilities ---------- */

function $(id) {
  return document.getElementById(id);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateOnly(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function todayISODate() {
  return localDateKey(new Date());
}

// Local (not UTC) YYYY-MM-DD for a Date or ISO timestamp — keeps entries grouped
// on the calendar day they actually happened in the user's own timezone.
function localDateKey(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function compressImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/* ---------- Tabs ---------- */

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
  $("screen-" + tabName).hidden = false;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  if (tabName === "history") {
    renderHistory();
    if (state.logView === "calendar") renderCalendar();
  }
  if (tabName === "jobs") renderManageLists();
  if (tabName === "report") {
    $("reportPreviewWrap").hidden = true;
  }
  if (tabName === "calc") {
    $("shareCalcPdfBtn").hidden = !(navigator.canShare && navigator.share);
    $("calcPdfStatus").textContent = "";
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

/* ---------- Capture tab ---------- */

function renderJobSelect(selectEl, includeAllOption) {
  const current = selectEl.value;
  selectEl.innerHTML = "";
  if (includeAllOption) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "All jobs";
    selectEl.appendChild(opt);
  }
  if (state.jobs.length === 0 && !includeAllOption) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Add a job site first";
    selectEl.appendChild(opt);
  }
  state.jobs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((job) => {
      const opt = document.createElement("option");
      opt.value = job.id;
      opt.textContent = job.name;
      selectEl.appendChild(opt);
    });
  if ([...selectEl.options].some((o) => o.value === current)) {
    selectEl.value = current;
  }
}

function renderEquipmentChips() {
  const wrap = $("equipmentGroups");
  wrap.innerHTML = "";

  const fleet = state.equipment.filter((e) => e.type === "fleet").sort((a, b) => a.name.localeCompare(b.name));
  const rental = state.equipment.filter((e) => e.type === "rental").sort((a, b) => a.name.localeCompare(b.name));

  const makeGroup = (label, items, isRental) => {
    const group = document.createElement("div");
    group.className = "equip-group";
    const lbl = document.createElement("div");
    lbl.className = "equip-group-label";
    lbl.textContent = label;
    group.appendChild(lbl);

    const grid = document.createElement("div");
    grid.className = "chip-grid";

    items.forEach((eq) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (state.selectedEquipIds.has(eq.id) ? " selected" : "");
      chip.textContent = eq.name;
      chip.addEventListener("click", () => {
        if (state.selectedEquipIds.has(eq.id)) {
          state.selectedEquipIds.delete(eq.id);
        } else {
          state.selectedEquipIds.add(eq.id);
        }
        renderEquipmentChips();
      });
      grid.appendChild(chip);
    });

    if (isRental) {
      const addChip = document.createElement("button");
      addChip.type = "button";
      addChip.className = "chip chip-add";
      addChip.textContent = "+ Add rental/leased";
      addChip.addEventListener("click", addRentalEquipmentPrompt);
      grid.appendChild(addChip);
    }

    group.appendChild(grid);
    wrap.appendChild(group);
  };

  makeGroup("GCI Fleet", fleet, false);
  makeGroup("Rental / Leased", rental, true);
}

async function addRentalEquipmentPrompt() {
  const name = prompt("Rental/leased equipment name (e.g. Rented Excavator - ABC Rental):");
  if (!name || !name.trim()) return;
  const eq = { id: uid(), name: name.trim(), type: "rental" };
  await idbPut("equipment", eq);
  state.equipment.push(eq);
  state.selectedEquipIds.add(eq.id);
  renderEquipmentChips();
  renderManageLists();
  toast("Rental equipment added");
}

function updateSaveEnabled() {
  const hasJob = $("jobSelect").value !== "";
  $("saveEntryBtn").disabled = !(state.photoBlob && hasJob);
}

$("photoDrop").addEventListener("click", (e) => {
  // label already triggers input via native behavior; guard for double trigger not needed
});

$("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  toast("Processing photo...");
  try {
    const blob = await compressImage(file);
    state.photoBlob = blob;
    const url = URL.createObjectURL(blob);
    $("photoPreview").src = url;
    $("photoPreview").hidden = false;
    $("photoDropEmpty").hidden = true;
    $("retakeBtn").hidden = false;
    updateSaveEnabled();
  } catch (err) {
    toast("Could not read photo, try again");
  }
});

$("retakeBtn").addEventListener("click", (e) => {
  e.preventDefault();
  state.photoBlob = null;
  $("photoPreview").hidden = true;
  $("photoDropEmpty").hidden = false;
  $("retakeBtn").hidden = true;
  $("photoInput").value = "";
  updateSaveEnabled();
});

$("jobSelect").addEventListener("change", updateSaveEnabled);

$("addJobQuick").addEventListener("click", async () => {
  const name = prompt("New job site name:");
  if (!name || !name.trim()) return;
  const job = { id: uid(), name: name.trim() };
  await idbPut("jobs", job);
  state.jobs.push(job);
  renderJobSelect($("jobSelect"), false);
  $("jobSelect").value = job.id;
  renderJobSelect($("historyJobFilter"), true);
  renderJobSelect($("reportJobFilter"), true);
  updateSaveEnabled();
  toast("Job added");
});

const geocodeCache = new Map();

async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error("geocode failed");
    const data = await res.json();
    const address = data && data.display_name ? data.display_name : null;
    geocodeCache.set(key, address);
    return address;
  } catch (err) {
    return null;
  }
}

function locationDisplayText(loc) {
  if (!loc) return "";
  const coords = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
  return loc.address ? `${loc.address}\n${coords}` : coords;
}

function mapsLink(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

async function shareLocationPin(loc) {
  if (!loc) return;
  const url = mapsLink(loc.lat, loc.lng);
  const shareText = loc.address || `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Job Site Location", text: shareText, url });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${shareText}\n${url}`);
    toast("Location link copied to clipboard");
  } catch (err) {
    window.open(url, "_blank");
  }
}

$("shareLocationBtn").addEventListener("click", () => shareLocationPin(state.location));
$("modalShareLocationBtn").addEventListener("click", () => {
  if (activeModalEntry) shareLocationPin(activeModalEntry.location);
});

$("addLocationBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    toast("Location not supported on this device");
    return;
  }
  $("addLocationBtn").textContent = "📍 Getting location...";
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      state.location = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        address: null,
      };
      $("locationLabel").textContent = `${locationDisplayText(state.location)} — looking up address...`;
      $("addLocationBtn").textContent = "📍 Location added";
      $("shareLocationBtn").hidden = false;

      const address = await reverseGeocode(state.location.lat, state.location.lng);
      if (state.location) {
        state.location.address = address;
        $("locationLabel").textContent = locationDisplayText(state.location);
      }
    },
    () => {
      toast("Couldn't get location — check permissions");
      $("addLocationBtn").textContent = "📍 Add current location";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$("saveEntryBtn").addEventListener("click", async () => {
  if (!state.photoBlob || !$("jobSelect").value) return;
  const jobId = $("jobSelect").value;
  const job = state.jobs.find((j) => j.id === jobId);
  const equipItems = state.equipment.filter((e) => state.selectedEquipIds.has(e.id));

  const entry = {
    id: uid(),
    timestamp: new Date().toISOString(),
    jobId,
    jobName: job ? job.name : "Unknown job",
    equipment: equipItems.map((e) => ({ id: e.id, name: e.name, type: e.type })),
    note: $("noteInput").value.trim(),
    photoBlob: state.photoBlob,
    location: state.location,
  };

  await idbPut("entries", entry);
  state.entries.unshift(entry);

  // Reset photo + note; keep job/equipment/location selected for fast repeat logging
  state.photoBlob = null;
  $("photoPreview").hidden = true;
  $("photoDropEmpty").hidden = false;
  $("retakeBtn").hidden = true;
  $("photoInput").value = "";
  $("noteInput").value = "";
  updateSaveEnabled();

  toast("Progress entry saved");
});

/* ---------- History tab ---------- */

const objectUrlCache = new Map();
function blobUrlFor(entryId, blob) {
  if (objectUrlCache.has(entryId)) return objectUrlCache.get(entryId);
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(entryId, url);
  return url;
}

function getFilteredHistoryEntries() {
  const jobFilter = $("historyJobFilter").value;
  const dateFilter = $("historyDateFilter").value;
  return state.entries.filter((e) => {
    if (jobFilter && e.jobId !== jobFilter) return false;
    if (dateFilter && localDateKey(e.timestamp) !== dateFilter) return false;
    return true;
  });
}

function buildEntryCard(entry) {
  const card = document.createElement("div");
  card.className = "entry-card";
  card.addEventListener("click", () => openEntryModal(entry));

  const img = document.createElement("img");
  img.className = "entry-thumb";
  img.src = blobUrlFor(entry.id, entry.photoBlob);
  card.appendChild(img);

  const info = document.createElement("div");
  info.className = "entry-info";

  const jobEl = document.createElement("div");
  jobEl.className = "entry-job";
  jobEl.textContent = entry.jobName;
  info.appendChild(jobEl);

  const dateEl = document.createElement("div");
  dateEl.className = "entry-date";
  dateEl.textContent = fmtDateTime(entry.timestamp);
  info.appendChild(dateEl);

  if (entry.equipment && entry.equipment.length) {
    const tags = document.createElement("div");
    tags.className = "entry-tags";
    entry.equipment.forEach((eq) => {
      const tag = document.createElement("span");
      tag.className = "entry-tag" + (eq.type === "rental" ? " rental" : "");
      tag.textContent = eq.name;
      tags.appendChild(tag);
    });
    info.appendChild(tags);
  }

  if (entry.note) {
    const note = document.createElement("div");
    note.className = "entry-note";
    note.textContent = entry.note;
    info.appendChild(note);
  }

  card.appendChild(info);
  return card;
}

function renderHistory() {
  renderJobSelect($("historyJobFilter"), true);
  const list = $("historyList");
  list.innerHTML = "";
  const entries = getFilteredHistoryEntries().sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  $("historyEmpty").hidden = entries.length > 0;

  entries.forEach((entry) => list.appendChild(buildEntryCard(entry)));
}

$("historyJobFilter").addEventListener("change", renderHistory);
$("historyDateFilter").addEventListener("change", renderHistory);
$("clearFiltersBtn").addEventListener("click", () => {
  $("historyJobFilter").value = "";
  $("historyDateFilter").value = "";
  renderHistory();
});

/* ---------- Log view toggle (List / Calendar) ---------- */

state.logView = "list";

function setLogView(view) {
  state.logView = view;
  $("viewListBtn").classList.toggle("active", view === "list");
  $("viewCalendarBtn").classList.toggle("active", view === "calendar");
  $("logListView").hidden = view !== "list";
  $("logCalendarView").hidden = view !== "calendar";
  if (view === "calendar") renderCalendar();
}

$("viewListBtn").addEventListener("click", () => setLogView("list"));
$("viewCalendarBtn").addEventListener("click", () => setLogView("calendar"));

/* ---------- Calendar ---------- */

state.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
state.selectedCalDate = null;

function entriesByDateMap() {
  const map = new Map();
  state.entries.forEach((e) => {
    const d = localDateKey(e.timestamp);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(e);
  });
  return map;
}

function renderCalendar() {
  const map = entriesByDateMap();
  const monthDate = state.calendarMonth;
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();

  $("calMonthLabel").textContent = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const grid = $("calendarGrid");
  grid.innerHTML = "";

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = todayISODate();

  for (let i = 0; i < startOffset; i++) {
    const cell = document.createElement("div");
    cell.className = "cal-day empty";
    grid.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasEntries = map.has(dateStr);

    const cell = document.createElement("div");
    cell.className = "cal-day";
    if (hasEntries) cell.classList.add("has-entries");
    if (dateStr === todayStr) cell.classList.add("is-today");
    if (dateStr === state.selectedCalDate) cell.classList.add("is-selected");

    const num = document.createElement("div");
    num.textContent = String(day);
    cell.appendChild(num);

    if (hasEntries) {
      const dot = document.createElement("div");
      dot.className = "cal-day-dot";
      cell.appendChild(dot);
    }

    cell.addEventListener("click", () => {
      state.selectedCalDate = dateStr;
      renderCalendar();
      renderCalDay(dateStr, (map.get(dateStr) || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
    });

    grid.appendChild(cell);
  }
}

function renderCalDay(dateStr, entries) {
  if (!dateStr) {
    $("calDayCard").hidden = true;
    $("calDayEmpty").hidden = false;
    return;
  }
  $("calDayEmpty").hidden = true;
  $("calDayCard").hidden = false;
  $("calDayTitle").textContent = fmtDateOnly(dateStr + "T00:00:00");

  const wrap = $("calDayEntries");
  wrap.innerHTML = "";
  if (entries.length === 0) {
    const p = document.createElement("p");
    p.className = "hint-text";
    p.textContent = "No entries logged this day.";
    wrap.appendChild(p);
  } else {
    entries.forEach((entry) => wrap.appendChild(buildEntryCard(entry)));
  }

  $("calDayPdfBtn").onclick = async () => {
    $("calDayPdfBtn").disabled = true;
    $("calDayPdfBtn").textContent = "Generating PDF...";
    try {
      const doc = await generateReportPdf(entries, { jobId: "", start: dateStr, end: dateStr });
      doc.save(reportFilename({ jobId: "", start: dateStr, end: dateStr }));
    } catch (err) {
      toast("Couldn't generate PDF — try again");
    } finally {
      $("calDayPdfBtn").disabled = false;
      $("calDayPdfBtn").textContent = "📄 Download PDF for this day";
    }
  };

  $("calDayDeleteBtn").hidden = entries.length === 0;
  $("calDayDeleteBtn").onclick = async () => {
    const dayLabel = fmtDateOnly(dateStr + "T00:00:00");
    if (
      !confirm(
        `Delete all ${entries.length} entr${entries.length === 1 ? "y" : "ies"} logged on ${dayLabel}? This cannot be undone.`
      )
    )
      return;

    await Promise.all(entries.map((e) => idbDelete("entries", e.id)));
    entries.forEach((e) => {
      if (objectUrlCache.has(e.id)) {
        URL.revokeObjectURL(objectUrlCache.get(e.id));
        objectUrlCache.delete(e.id);
      }
    });
    const deletedIds = new Set(entries.map((e) => e.id));
    state.entries = state.entries.filter((e) => !deletedIds.has(e.id));

    toast(`Deleted ${dayLabel}`);
    renderCalendar();
    renderCalDay(dateStr, []);
  };
}

$("calPrevBtn").addEventListener("click", () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
$("calNextBtn").addEventListener("click", () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
$("calTodayBtn").addEventListener("click", () => {
  const now = new Date();
  state.calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  state.selectedCalDate = todayISODate();
  renderCalendar();
  const map = entriesByDateMap();
  renderCalDay(state.selectedCalDate, (map.get(state.selectedCalDate) || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
});

/* ---------- Entry modal ---------- */

let activeModalEntry = null;

function openEntryModal(entry) {
  activeModalEntry = entry;
  $("modalPhoto").src = blobUrlFor(entry.id, entry.photoBlob);
  $("modalJob").textContent = entry.jobName;
  $("modalDate").textContent = fmtDateTime(entry.timestamp);
  const equipWrap = $("modalEquip");
  equipWrap.innerHTML = "";
  (entry.equipment || []).forEach((eq) => {
    const tag = document.createElement("span");
    tag.className = "entry-tag" + (eq.type === "rental" ? " rental" : "");
    tag.textContent = eq.name;
    equipWrap.appendChild(tag);
  });
  $("modalNote").textContent = entry.note || "No notes added.";

  if (entry.location) {
    $("modalLocation").textContent = `📍 ${locationDisplayText(entry.location)}`;
    $("modalShareLocationBtn").hidden = false;
    if (!entry.location.address) {
      reverseGeocode(entry.location.lat, entry.location.lng).then(async (address) => {
        if (!address || activeModalEntry !== entry) return;
        entry.location.address = address;
        $("modalLocation").textContent = `📍 ${locationDisplayText(entry.location)}`;
        await idbPut("entries", entry);
      });
    }
  } else {
    $("modalLocation").textContent = "";
    $("modalShareLocationBtn").hidden = true;
  }

  $("entryModal").hidden = false;
}

$("closeModalBtn").addEventListener("click", () => {
  $("entryModal").hidden = true;
  activeModalEntry = null;
});

$("entryModal").addEventListener("click", (e) => {
  if (e.target.id === "entryModal") {
    $("entryModal").hidden = true;
    activeModalEntry = null;
  }
});

$("deleteEntryBtn").addEventListener("click", async () => {
  if (!activeModalEntry) return;
  if (!confirm("Delete this progress entry? This cannot be undone.")) return;
  await idbDelete("entries", activeModalEntry.id);
  state.entries = state.entries.filter((e) => e.id !== activeModalEntry.id);
  if (objectUrlCache.has(activeModalEntry.id)) {
    URL.revokeObjectURL(objectUrlCache.get(activeModalEntry.id));
    objectUrlCache.delete(activeModalEntry.id);
  }
  $("entryModal").hidden = true;
  activeModalEntry = null;
  renderHistory();
  toast("Entry deleted");
});

/* ---------- Report tab ---------- */

$("buildReportBtn").addEventListener("click", () => {
  const jobId = $("reportJobFilter").value;
  const start = $("reportStart").value;
  const end = $("reportEnd").value;

  let entries = state.entries.filter((e) => {
    if (jobId && e.jobId !== jobId) return false;
    const d = localDateKey(e.timestamp);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
  entries = entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  state.reportEntries = entries;
  $("reportCount").textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"} found`;
  $("reportPreviewWrap").hidden = false;
  $("pdfStatus").textContent = "";
  $("sharePdfBtn").hidden = !(navigator.canShare && navigator.share);
  buildPrintArea(entries, { jobId, start, end });
});

function buildPrintArea(entries, filters) {
  const printArea = $("printArea");
  printArea.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:14px;border-bottom:3px solid #7B1E1E;padding-bottom:12px;margin-bottom:16px;";
  header.innerHTML = `
    <img src="logo.svg" style="height:44px;" />
    <div>
      <h1 style="margin:0;font-size:20px;color:#7B1E1E;">Daily Progress Report</h1>
      <div style="font-size:12px;color:#595959;">
        ${filters.jobId ? "Job: " + (state.jobs.find((j) => j.id === filters.jobId)?.name || "") : "All job sites"}
        ${filters.start || filters.end ? " &nbsp;|&nbsp; " + (filters.start || "…") + " to " + (filters.end || "…") : ""}
      </div>
    </div>
  `;
  printArea.appendChild(header);

  if (entries.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No progress entries found for this selection.";
    printArea.appendChild(p);
    return;
  }

  // group by date
  const byDate = new Map();
  entries.forEach((e) => {
    const d = localDateKey(e.timestamp);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(e);
  });

  [...byDate.keys()].sort().forEach((dateKey) => {
    const dayEntries = byDate.get(dateKey);
    const dayHeader = document.createElement("h2");
    dayHeader.style.cssText = "font-size:15px;color:#1F3864;border-bottom:1px solid #BFBFBF;padding-bottom:4px;margin:20px 0 10px;";
    dayHeader.textContent = fmtDateOnly(dateKey + "T00:00:00");
    printArea.appendChild(dayHeader);

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:14px;page-break-inside:avoid;";

    dayEntries.forEach((e) => {
      const card = document.createElement("div");
      card.style.cssText = "border:1px solid #D9D9D9;border-radius:8px;padding:10px;break-inside:avoid;";
      const equipStr = (e.equipment || []).map((eq) => eq.name).join(", ") || "—";
      const locStr = e.location ? locationDisplayText(e.location).replace("\n", " — ") : "";
      card.innerHTML = `
        <img src="${blobUrlFor(e.id, e.photoBlob)}" style="width:100%;max-height:220px;object-fit:cover;border-radius:6px;margin-bottom:8px;" />
        <div style="font-weight:700;color:#7B1E1E;font-size:13px;">${escapeHtml(e.jobName)}</div>
        <div style="font-size:11px;color:#595959;margin-bottom:4px;">${fmtDateTime(e.timestamp)}</div>
        <div style="font-size:11px;margin-bottom:4px;"><strong>Equipment:</strong> ${escapeHtml(equipStr)}</div>
        ${e.note ? `<div style="font-size:11px;margin-bottom:4px;"><strong>Notes:</strong> ${escapeHtml(e.note)}</div>` : ""}
        ${locStr ? `<div style="font-size:10px;color:#595959;">📍 ${escapeHtml(locStr)}</div>` : ""}
      `;
      grid.appendChild(card);
    });

    printArea.appendChild(grid);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

$("printReportBtn").addEventListener("click", () => {
  window.print();
});

/* ---------- Business-grade PDF report ---------- */

let logoIconDataUrl = null;
async function getLogoIconDataUrl() {
  if (logoIconDataUrl) return logoIconDataUrl;
  const res = await fetch("icon-512.png");
  const blob = await res.blob();
  logoIconDataUrl = await blobToDataURL(blob);
  return logoIconDataUrl;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getImageDims(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 4, h: 3 });
    img.src = dataUrl;
  });
}

function sanitizeFilename(str) {
  return String(str).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

async function generateReportPdf(entries, filters) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const contentW = pageWidth - marginX * 2;

  const logoUrl = await getLogoIconDataUrl().catch(() => null);

  // Pre-load every photo as a dataURL + natural size so drawing stays synchronous.
  const imageData = new Map();
  for (const e of entries) {
    const dataUrl = await blobToDataURL(e.photoBlob);
    const dims = await getImageDims(dataUrl);
    imageData.set(e.id, { dataUrl, ...dims });
  }

  function drawHeader() {
    if (logoUrl) doc.addImage(logoUrl, "PNG", marginX, 22, 22, 22);
    doc.setFont("times", "bold");
    doc.setFontSize(15);
    doc.setTextColor(123, 30, 30);
    doc.text("GILBERT CONSTRUCTION L.L.C.", marginX + 30, 34);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(89, 89, 89);
    doc.text("Daily Job Site Progress Report", marginX + 30, 47);
    doc.setDrawColor(123, 30, 30);
    doc.setLineWidth(1.5);
    doc.line(marginX, 58, pageWidth - marginX, 58);
    return 78;
  }

  function drawFooter(pageNum, totalPages) {
    doc.setDrawColor(217, 217, 217);
    doc.setLineWidth(0.75);
    doc.line(marginX, pageHeight - 38, pageWidth - marginX, pageHeight - 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(89, 89, 89);
    doc.text("GCI — Job Site Progress Photo Log", marginX, pageHeight - 26);
    doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - marginX, pageHeight - 26, { align: "right" });
  }

  function drawMetaBlock(y) {
    const boxH = 62;
    doc.setFillColor(245, 240, 238);
    doc.setDrawColor(191, 191, 191);
    doc.setLineWidth(0.75);
    doc.roundedRect(marginX, y, contentW, boxH, 4, 4, "FD");

    const jobLabel = filters.jobId
      ? state.jobs.find((j) => j.id === filters.jobId)?.name || "Unknown"
      : "All Job Sites";
    const rangeLabel = `${filters.start || "—"}  to  ${filters.end || "—"}`;
    const rows = [
      ["Job Site(s):", jobLabel],
      ["Date Range:", rangeLabel],
      ["Total Entries:", String(entries.length)],
      ["Report Generated:", new Date().toLocaleString()],
    ];
    let ry = y + 17;
    const colGap = contentW / 2;
    rows.forEach((row, i) => {
      const cx = marginX + 14 + (i % 2 === 1 ? colGap : 0);
      const cy = ry + Math.floor(i / 2) * 16;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(31, 56, 100);
      doc.text(row[0], cx, cy);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(38, 38, 38);
      doc.text(row[1], cx + 82, cy);
    });
    return y + boxH + 20;
  }

  let y = drawHeader();
  y = drawMetaBlock(y);

  if (entries.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(89, 89, 89);
    doc.text("No progress entries found for this selection.", marginX, y + 10);
  } else {
    const byDate = new Map();
    entries.forEach((e) => {
      const d = localDateKey(e.timestamp);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(e);
    });

    const photoW = 150;
    const photoMaxH = 105;
    const textX = marginX + photoW + 24;
    const textW = contentW - photoW - 24;
    const rowH = 136;

    for (const dateKey of [...byDate.keys()].sort()) {
      if (y + 34 > pageHeight - 50) {
        doc.addPage();
        y = drawHeader();
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(31, 56, 100);
      doc.text(fmtDateOnly(dateKey + "T00:00:00"), marginX, y + 10);
      doc.setDrawColor(191, 191, 191);
      doc.setLineWidth(0.75);
      doc.line(marginX, y + 16, pageWidth - marginX, y + 16);
      y += 30;

      for (const e of byDate.get(dateKey)) {
        if (y + rowH > pageHeight - 50) {
          doc.addPage();
          y = drawHeader();
        }

        doc.setDrawColor(217, 217, 217);
        doc.setLineWidth(0.75);
        doc.roundedRect(marginX, y, contentW, rowH, 4, 4, "S");

        const img = imageData.get(e.id);
        let drawW = photoW - 16;
        let drawH = (img.h / img.w) * drawW;
        if (drawH > photoMaxH) {
          drawH = photoMaxH;
          drawW = (img.w / img.h) * drawH;
        }
        const imgX = marginX + 8 + (photoW - 16 - drawW) / 2;
        doc.addImage(img.dataUrl, "JPEG", imgX, y + 8, drawW, drawH);

        let ty = y + 20;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(123, 30, 30);
        doc.text(e.jobName, textX, ty);
        ty += 14;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(89, 89, 89);
        doc.text(fmtDateTime(e.timestamp), textX, ty);
        ty += 15;

        const equipStr = (e.equipment || []).map((eq) => eq.name).join(", ") || "None logged";
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(31, 56, 100);
        doc.text("Equipment:", textX, ty);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(38, 38, 38);
        const equipLinesFull = doc.splitTextToSize(equipStr, textW - 58);
        const equipLines = equipLinesFull.slice(0, 2);
        if (equipLinesFull.length > 2) {
          equipLines[1] = equipLines[1].replace(/\s*\S*$/, "") + "…";
        }
        doc.text(equipLines, textX + 58, ty);
        ty += 12 * equipLines.length;

        if (e.note) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(31, 56, 100);
          doc.text("Notes:", textX, ty);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(38, 38, 38);
          const noteLinesFull = doc.splitTextToSize(e.note, textW - 40);
          const noteLines = noteLinesFull.slice(0, 2);
          if (noteLinesFull.length > 2) {
            noteLines[1] = noteLines[1].replace(/\s*\S*$/, "") + "…";
          }
          doc.text(noteLines, textX + 40, ty);
          ty += 12 * noteLines.length;
        }

        if (e.location) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(89, 89, 89);
          const coords = `${e.location.lat.toFixed(5)}, ${e.location.lng.toFixed(5)}`;
          const rawLoc = e.location.address ? `Location: ${e.location.address} (${coords})` : `GPS: ${coords}`;
          const locLinesFull = doc.splitTextToSize(rawLoc, textW);
          const locLine =
            locLinesFull.length > 1 ? locLinesFull[0].replace(/\s*\S*$/, "") + "…" : locLinesFull[0];
          doc.text(locLine, textX, Math.min(ty + 12, y + rowH - 10));
        }

        y += rowH + 10;
      }
    }
  }

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawFooter(p, totalPages);
  }

  return doc;
}

function reportFilename(filters) {
  const jobPart = filters.jobId
    ? sanitizeFilename(state.jobs.find((j) => j.id === filters.jobId)?.name || "job")
    : "AllJobs";
  const datePart = `${filters.start || "start"}_to_${filters.end || "end"}`;
  return `GCI_Progress_Report_${jobPart}_${datePart}.pdf`;
}

$("downloadPdfBtn").addEventListener("click", async () => {
  const entries = state.reportEntries || [];
  const filters = {
    jobId: $("reportJobFilter").value,
    start: $("reportStart").value,
    end: $("reportEnd").value,
  };
  $("pdfStatus").textContent = "Generating PDF...";
  $("downloadPdfBtn").disabled = true;
  try {
    const doc = await generateReportPdf(entries, filters);
    doc.save(reportFilename(filters));
    $("pdfStatus").textContent = "PDF downloaded.";
  } catch (err) {
    $("pdfStatus").textContent = "Couldn't generate PDF — try again.";
  } finally {
    $("downloadPdfBtn").disabled = false;
  }
});

$("sharePdfBtn").addEventListener("click", async () => {
  const entries = state.reportEntries || [];
  const filters = {
    jobId: $("reportJobFilter").value,
    start: $("reportStart").value,
    end: $("reportEnd").value,
  };
  $("pdfStatus").textContent = "Preparing report to share...";
  $("sharePdfBtn").disabled = true;
  try {
    const doc = await generateReportPdf(entries, filters);
    const blob = doc.output("blob");
    const file = new File([blob], reportFilename(filters), { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: "Gilbert Construction L.L.C. — Daily Progress Report",
        text: "Daily job site progress report attached.",
      });
      $("pdfStatus").textContent = "Shared.";
    } else {
      doc.save(reportFilename(filters));
      $("pdfStatus").textContent = "Sharing isn't supported here — PDF downloaded instead.";
    }
  } catch (err) {
    if (err && err.name !== "AbortError") {
      $("pdfStatus").textContent = "Couldn't share — try downloading instead.";
    }
  } finally {
    $("sharePdfBtn").disabled = false;
  }
});

/* ---------- Manage tab (Jobs + Equipment) ---------- */

function renderManageLists() {
  const jobList = $("jobList");
  jobList.innerHTML = "";
  state.jobs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((job) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = job.name;
      li.appendChild(span);
      const btn = document.createElement("button");
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove job site "${job.name}"? Existing photo entries for it are kept.`)) return;
        await idbDelete("jobs", job.id);
        state.jobs = state.jobs.filter((j) => j.id !== job.id);
        renderManageLists();
        renderJobSelect($("jobSelect"), false);
        renderJobSelect($("historyJobFilter"), true);
        renderJobSelect($("reportJobFilter"), true);
        updateSaveEnabled();
      });
      li.appendChild(btn);
      jobList.appendChild(li);
    });

  const fleetList = $("fleetList");
  fleetList.innerHTML = "";
  const rentalList = $("rentalList");
  rentalList.innerHTML = "";

  state.equipment
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((eq) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = eq.name;
      li.appendChild(span);
      const btn = document.createElement("button");
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove "${eq.name}" from the equipment list?`)) return;
        await idbDelete("equipment", eq.id);
        state.equipment = state.equipment.filter((x) => x.id !== eq.id);
        state.selectedEquipIds.delete(eq.id);
        renderManageLists();
        renderEquipmentChips();
      });
      li.appendChild(btn);
      (eq.type === "rental" ? rentalList : fleetList).appendChild(li);
    });
}

$("addJobBtn").addEventListener("click", async () => {
  const input = $("newJobInput");
  const name = input.value.trim();
  if (!name) return;
  const job = { id: uid(), name };
  await idbPut("jobs", job);
  state.jobs.push(job);
  input.value = "";
  renderManageLists();
  renderJobSelect($("jobSelect"), false);
  renderJobSelect($("historyJobFilter"), true);
  renderJobSelect($("reportJobFilter"), true);
  updateSaveEnabled();
  toast("Job added");
});

$("addFleetBtn").addEventListener("click", async () => {
  const input = $("newFleetInput");
  const name = input.value.trim();
  if (!name) return;
  const eq = { id: uid(), name, type: "fleet" };
  await idbPut("equipment", eq);
  state.equipment.push(eq);
  input.value = "";
  renderManageLists();
  renderEquipmentChips();
  toast("Fleet equipment added");
});

$("addRentalBtn").addEventListener("click", async () => {
  const input = $("newRentalInput");
  const name = input.value.trim();
  if (!name) return;
  const eq = { id: uid(), name, type: "rental" };
  await idbPut("equipment", eq);
  state.equipment.push(eq);
  input.value = "";
  renderManageLists();
  renderEquipmentChips();
  toast("Rental equipment added");
});

/* ---------- Excavation calculators ---------- */

const calcLastCY = { rect: null, elev: null, trench: null, grid: null };
let gridReadings = [null, null, null, null, null]; // canonical feet values

/* ---- Unit conversion (feet is the canonical internal unit) ---- */

let calcUnitMode = "dft"; // dft | ftin | in | m
const FT_PER_M = 3.28084;
const SQFT_PER_SQM = 10.7639;

const DIM_FIELD_LABELS = {
  "rect:length": "Length",
  "rect:width": "Width",
  "rect:depth": "Depth",
  "elev:existing": "Existing Elev.",
  "elev:proposed": "Proposed Elev.",
  "elev:area": "Area",
  "trench:topWidth": "Top Width",
  "trench:bottomWidth": "Bottom Width",
  "trench:depth": "Depth",
  "trench:length": "Length",
  "grid:area": "Pad / Pond Area",
};

function unitSuffix(unitType, mode) {
  if (unitType === "area") return mode === "m" ? "sq m" : "sq ft";
  switch (mode) {
    case "ftin":
      return "ft-in";
    case "in":
      return "in";
    case "m":
      return "m";
    default:
      return "ft";
  }
}

function parseLengthToFeet(raw, mode) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (str === "") return null;
  if (mode === "ftin") {
    const m = str.match(/^(-)?(\d+(?:\.\d+)?)\s*'?\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
    if (m) {
      const sign = m[1] ? -1 : 1;
      const ft = parseFloat(m[2]);
      const inch = m[3] ? parseFloat(m[3]) : 0;
      return sign * (ft + inch / 12);
    }
    const fallback = parseFloat(str);
    return Number.isNaN(fallback) ? null : fallback;
  }
  const v = parseFloat(str);
  if (Number.isNaN(v)) return null;
  if (mode === "in") return v / 12;
  if (mode === "m") return v * FT_PER_M;
  return v; // dft
}

function parseAreaToSqFt(raw, mode) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (str === "") return null;
  const v = parseFloat(str);
  if (Number.isNaN(v)) return null;
  return mode === "m" ? v * SQFT_PER_SQM : v;
}

function formatFeetForMode(feet, mode) {
  if (feet === null || feet === undefined || Number.isNaN(feet)) return "";
  if (mode === "in") return (feet * 12).toFixed(1);
  if (mode === "m") return (feet / FT_PER_M).toFixed(2);
  if (mode === "ftin") {
    const sign = feet < 0 ? "-" : "";
    let abs = Math.abs(feet);
    let ft = Math.floor(abs);
    let inch = Math.round((abs - ft) * 12 * 10) / 10;
    if (inch >= 12) {
      ft += 1;
      inch = 0;
    }
    return `${sign}${ft}'${inch}"`;
  }
  return feet.toFixed(2); // dft
}

function formatSqFtForMode(sqft, mode) {
  if (sqft === null || sqft === undefined || Number.isNaN(sqft)) return "";
  return mode === "m" ? (sqft / SQFT_PER_SQM).toFixed(2) : sqft.toFixed(1);
}

function updateDimFieldLabelsAndPlaceholders() {
  document.querySelectorAll(".calc-input[data-unit]").forEach((el) => {
    const { calc, field, unit } = el.dataset;
    const base = DIM_FIELD_LABELS[`${calc}:${field}`];
    const suffix = unitSuffix(unit, calcUnitMode);
    const label = document.getElementById(`lbl-${calc}-${field}`);
    if (label && base) label.textContent = `${base} (${suffix})`;
    el.placeholder = unit === "linear" && calcUnitMode === "ftin" ? "e.g. 12'6\"" : "";
  });
}

function calcVal(name, field) {
  const el = document.querySelector(`.calc-input[data-calc="${name}"][data-field="${field}"]`);
  if (!el) return null;
  if (el.tagName === "SELECT") return el.value;
  if (el.value === "") return null;
  const unitType = el.dataset.unit;
  if (unitType === "linear") return parseLengthToFeet(el.value, calcUnitMode);
  if (unitType === "area") return parseAreaToSqFt(el.value, calcUnitMode);
  const v = parseFloat(el.value);
  return Number.isNaN(v) ? null : v;
}

function setCalcResult(id, html) {
  $(id).innerHTML = html;
}

function roundClean(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  const factor = Math.pow(10, decimals);
  return String(Math.round(n * factor) / factor);
}

function fmtCY(n) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Proportionally maps a real-world value into a drawing size, clamped so tiny
// or huge inputs still render as a legible shape rather than vanishing/overflowing.
function mapClamp(v, refMax, outMin, outMax) {
  const val = v === null || v === undefined || Number.isNaN(v) ? 0 : Math.abs(v);
  const t = Math.min(val / refMax, 1);
  return outMin + t * (outMax - outMin);
}

function setAttr(id, attr, value) {
  const el = document.getElementById(id);
  if (el) el.setAttribute(attr, value);
}
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateRectIllustration(length, width, depth) {
  const hasAll = length !== null && width !== null && depth !== null;
  const boxW = hasAll ? mapClamp(length, 150, 40, 190) : 120;
  const boxH = hasAll ? mapClamp(Math.abs(depth), 15, 20, 90) : 50;
  const boxX = 150 - boxW / 2;
  const gradeY = 50;
  const isFill = hasAll ? depth >= 0 : false;
  const boxY = isFill ? gradeY - boxH : gradeY;
  const dimLineY = isFill ? boxY - 12 : boxY + boxH + 12;

  setAttr("rectIllusBox", "x", boxX);
  setAttr("rectIllusBox", "y", boxY);
  setAttr("rectIllusBox", "width", boxW);
  setAttr("rectIllusBox", "height", boxH);
  setAttr("rectIllusBox", "fill", isFill ? "url(#fillHatch)" : "url(#cutHatch)");

  setAttr("rectDimLenLine", "x1", boxX);
  setAttr("rectDimLenLine", "x2", boxX + boxW);
  setAttr("rectDimLenLine", "y1", dimLineY);
  setAttr("rectDimLenLine", "y2", dimLineY);
  setAttr("rectDimLenTickA", "x1", boxX);
  setAttr("rectDimLenTickA", "x2", boxX);
  setAttr("rectDimLenTickA", "y1", dimLineY - 5);
  setAttr("rectDimLenTickA", "y2", dimLineY + 5);
  setAttr("rectDimLenTickB", "x1", boxX + boxW);
  setAttr("rectDimLenTickB", "x2", boxX + boxW);
  setAttr("rectDimLenTickB", "y1", dimLineY - 5);
  setAttr("rectDimLenTickB", "y2", dimLineY + 5);
  setAttr("rectDimLenLabel", "x", boxX + boxW / 2);
  setAttr("rectDimLenLabel", "y", isFill ? dimLineY - 6 : dimLineY + 16);

  setAttr("rectDimDepthLine", "y1", isFill ? boxY : gradeY);
  setAttr("rectDimDepthLine", "y2", isFill ? gradeY : boxY + boxH);
  setAttr("rectDimDepthTickB", "y1", isFill ? gradeY : boxY + boxH);
  setAttr("rectDimDepthTickB", "y2", isFill ? gradeY : boxY + boxH);

  setText("rectDimLenLabel", length !== null ? `Length: ${roundClean(length)}'` : "Length: —");
  setText(
    "rectDimDepthLabel",
    depth !== null ? `${isFill ? "Fill" : "Cut"}: ${roundClean(Math.abs(depth))}'` : "Depth: —"
  );
  setText("rectDimWidthLabel", width !== null ? `Width (into page): ${roundClean(width)}'` : "Width (into page): —");
}

const RECT_ISO_IDS = {
  floor: "isoFloorRect",
  wallLeft: "isoWallLeftRect",
  wallRight: "isoWallRightRect",
  gradeFront: "isoGradeFrontRect",
  gradeBack: "isoGradeBackRect",
};

function updateRectIsoIllustration(length, width, depth) {
  const hasAll = length !== null && width !== null && depth !== null;
  const lenPx = hasAll ? mapClamp(length, 150, 40, 150) : 110;
  const h = hasAll ? mapClamp(Math.abs(depth), 15, 20, 70) : 50;
  const widthOffset = hasAll ? mapClamp(width, 100, 30, 110) : 70;

  drawIsoExcavation(RECT_ISO_IDS, lenPx, lenPx, h, widthOffset);

  setText("isoLenLabelRect", length !== null ? `Length: ${roundClean(length)}'` : "Length: —");
  setText("isoDepthLabelRect", depth !== null ? `Depth: ${roundClean(Math.abs(depth))}'` : "Depth: —");
  setText("isoWidthLabelRect", width !== null ? `Width: ${roundClean(width)}'` : "Width: —");
}

$("rectViewSideBtn").addEventListener("click", () => {
  $("rectViewSideBtn").classList.add("active");
  $("rectViewIsoBtn").classList.remove("active");
  $("rectSideView").hidden = false;
  $("rectIsoView").hidden = true;
});
$("rectViewIsoBtn").addEventListener("click", () => {
  $("rectViewIsoBtn").classList.add("active");
  $("rectViewSideBtn").classList.remove("active");
  $("rectIsoView").hidden = false;
  $("rectSideView").hidden = true;
});

function computeRect() {
  const length = calcVal("rect", "length");
  const width = calcVal("rect", "width");
  const depth = calcVal("rect", "depth");
  updateRectIllustration(length, width, depth);
  updateRectIsoIllustration(length, width, depth);
  if (length === null || width === null || depth === null) {
    calcLastCY.rect = null;
    setCalcResult("result-rect", "Enter length, width &amp; depth");
    return;
  }
  const cy = (length * width * Math.abs(depth)) / 27;
  calcLastCY.rect = cy;
  const label = depth >= 0 ? "Fill" : "Cut";
  setCalcResult(
    "result-rect",
    `${label}: <span class="big">${fmtCY(cy)} cu. yd.</span><span class="muted">${roundClean(length)}' × ${roundClean(width)}' × ${roundClean(Math.abs(depth))}' ÷ 27</span>`
  );
}

function updateElevIllustration(existing, proposed, area) {
  const hasAll = existing !== null && proposed !== null && area !== null;
  const depth = hasAll ? existing - proposed : 0;
  const gap = hasAll ? mapClamp(depth, 12, 10, 60) : 50;
  const existingY = 40;
  const proposedY = existingY + (depth >= 0 ? gap : -gap === 0 ? gap : gap);
  // Cut: proposed below existing. Fill: proposed above existing.
  const isFill = depth < 0;
  const topY = isFill ? existingY - gap + gap : existingY; // existing line always drawn at existingY
  const propY = isFill ? existingY - gap : existingY + gap;

  setAttr("elevProposedLine", "y1", propY);
  setAttr("elevProposedLine", "y2", propY);
  setText("elevProposedLabel", "PROPOSED");
  setAttr("elevProposedLabel", "y", propY + (isFill ? -8 : 16));

  setAttr("elevDepthLine", "y1", existingY);
  setAttr("elevDepthLine", "y2", propY);
  setAttr("elevDepthTickA", "y1", existingY);
  setAttr("elevDepthTickA", "y2", existingY);
  setAttr("elevDepthTickB", "y1", propY);
  setAttr("elevDepthTickB", "y2", propY);

  const fillTop = Math.min(existingY, propY);
  const fillBottom = Math.max(existingY, propY);
  setAttr("elevFillArea", "points", `40,${fillTop} 260,${fillTop} 260,${fillBottom} 40,${fillBottom}`);
  const fillEl = document.getElementById("elevFillArea");
  if (fillEl) fillEl.setAttribute("fill", isFill ? "url(#fillHatch)" : "url(#cutHatch)");

  // Native ground always sits below whichever line is lower on screen —
  // the original grade when filling, the newly cut grade when cutting.
  setAttr("elevGroundArea", "y", fillBottom);
  setAttr("elevGroundArea", "height", 130 - fillBottom);

  setText("elevDepthLabel", hasAll ? `${isFill ? "Fill" : "Cut"}: ${Math.abs(depth).toFixed(2)}'` : "Depth: —");
  setText("elevAreaLabel", area !== null ? `Area: ${area} sq ft` : "Area: —");
}

const ELEV_ISO_IDS = {
  floor: "isoFloorElev",
  wallLeft: "isoWallLeftElev",
  wallRight: "isoWallRightElev",
  gradeFront: "isoGradeFrontElev",
  gradeBack: "isoGradeBackElev",
};

function updateElevIsoIllustration(existing, proposed, area) {
  const hasAll = existing !== null && proposed !== null && area !== null;
  const depth = hasAll ? Math.abs(existing - proposed) : null;
  const sidePx = hasAll ? mapClamp(Math.sqrt(area), 120, 40, 150) : 100;
  const h = hasAll ? mapClamp(depth, 12, 20, 70) : 45;

  drawIsoExcavation(ELEV_ISO_IDS, sidePx, sidePx, h, sidePx);

  setText("isoDepthLabelElev", depth !== null ? `Depth: ${roundClean(depth)}'` : "Depth: —");
  setText("isoAreaLabelElev", area !== null ? `Area: ${roundClean(area)} sq ft` : "Area: —");
}

$("elevViewSideBtn").addEventListener("click", () => {
  $("elevViewSideBtn").classList.add("active");
  $("elevViewIsoBtn").classList.remove("active");
  $("elevSideView").hidden = false;
  $("elevIsoView").hidden = true;
});
$("elevViewIsoBtn").addEventListener("click", () => {
  $("elevViewIsoBtn").classList.add("active");
  $("elevViewSideBtn").classList.remove("active");
  $("elevIsoView").hidden = false;
  $("elevSideView").hidden = true;
});

function computeElev() {
  const existing = calcVal("elev", "existing");
  const proposed = calcVal("elev", "proposed");
  const area = calcVal("elev", "area");
  updateElevIllustration(existing, proposed, area);
  updateElevIsoIllustration(existing, proposed, area);
  if (existing === null || proposed === null || area === null) {
    calcLastCY.elev = null;
    setCalcResult("result-elev", "Enter elevations &amp; area");
    return;
  }
  const depth = existing - proposed;
  const cy = (area * Math.abs(depth)) / 27;
  calcLastCY.elev = cy;
  const label = depth > 0 ? "Cut" : depth < 0 ? "Fill" : "Level — no cut/fill";
  setCalcResult(
    "result-elev",
    `${label}: <span class="big">${fmtCY(cy)} cu. yd.</span><span class="muted">Depth ${Math.abs(depth).toFixed(2)}' × ${area} sq ft ÷ 27</span>`
  );
}

function updateTrenchIllustration(topWidth, bottomWidth, depth) {
  const hasAll = topWidth !== null && bottomWidth !== null && depth !== null;
  const topW = hasAll ? mapClamp(topWidth, 20, 30, 170) : 120;
  const botW = hasAll ? mapClamp(bottomWidth, 20, 20, 130) : 90;
  const h = hasAll ? mapClamp(Math.abs(depth), 12, 25, 90) : 60;
  const gradeY = 45;
  const isFill = hasAll ? depth >= 0 : false;
  const topY = isFill ? gradeY - h : gradeY;
  const botY = isFill ? gradeY : gradeY + h;
  const topX1 = 150 - topW / 2;
  const topX2 = 150 + topW / 2;
  const botX1 = 150 - botW / 2;
  const botX2 = 150 + botW / 2;
  setAttr("trenchShape", "points", `${topX1},${topY} ${topX2},${topY} ${botX2},${botY} ${botX1},${botY}`);
  setAttr("trenchShape", "fill", isFill ? "url(#fillHatch)" : "url(#cutHatch)");
  setAttr("trenchTopLabel", "y", topY - 8);
  setAttr("trenchBottomLabel", "y", botY + 15);
  setAttr("trenchDepthLine", "y1", topY);
  setAttr("trenchDepthLine", "y2", botY);
  setAttr("trenchDepthTickA", "y1", topY);
  setAttr("trenchDepthTickA", "y2", topY);
  setAttr("trenchDepthTickB", "y1", botY);
  setAttr("trenchDepthTickB", "y2", botY);
  setText("trenchTopLabel", topWidth !== null ? `Top width: ${roundClean(topWidth)}'` : "Top width: —");
  setText("trenchBottomLabel", bottomWidth !== null ? `Bottom width: ${roundClean(bottomWidth)}'` : "Bottom width: —");
  setText(
    "trenchDepthLabel",
    depth !== null ? `${isFill ? "Fill" : "Cut"}: ${roundClean(Math.abs(depth))}'` : "Depth: —"
  );
}

// Generic isometric excavation drawer, shared by every 3D-shaped calculator.
// topWpx/botWpx = front cross-section widths, hPx = depth, extrudePx = receding "length" axis.
function drawIsoExcavation(ids, topWpx, botWpx, hPx, extrudePx) {
  const cx = 90;
  const frontBotY = 155;
  const frontTopY = frontBotY - hPx;
  const offX = extrudePx * 0.866;
  const offY = -extrudePx * 0.5;

  const FTL = [cx - topWpx / 2, frontTopY];
  const FTR = [cx + topWpx / 2, frontTopY];
  const FBR = [cx + botWpx / 2, frontBotY];
  const FBL = [cx - botWpx / 2, frontBotY];
  const BTL = [FTL[0] + offX, FTL[1] + offY];
  const BTR = [FTR[0] + offX, FTR[1] + offY];
  const BBR = [FBR[0] + offX, FBR[1] + offY];
  const BBL = [FBL[0] + offX, FBL[1] + offY];

  const pts = (arr) => arr.map((p) => p.join(",")).join(" ");
  setAttr(ids.floor, "points", pts([FBL, BBL, BBR, FBR]));
  setAttr(ids.wallLeft, "points", pts([FTL, BTL, BBL, FBL]));
  setAttr(ids.wallRight, "points", pts([FTR, BTR, BBR, FBR]));

  setAttr(ids.gradeFront, "x1", FTL[0] - 25);
  setAttr(ids.gradeFront, "y1", FTL[1]);
  setAttr(ids.gradeFront, "x2", FTR[0] + 25);
  setAttr(ids.gradeFront, "y2", FTR[1]);
  setAttr(ids.gradeBack, "x1", BTL[0] - 25);
  setAttr(ids.gradeBack, "y1", BTL[1]);
  setAttr(ids.gradeBack, "x2", BTR[0] + 25);
  setAttr(ids.gradeBack, "y2", BTR[1]);
}

const TRENCH_ISO_IDS = {
  floor: "isoFloor",
  wallLeft: "isoWallLeft",
  wallRight: "isoWallRight",
  gradeFront: "isoGradeFront",
  gradeBack: "isoGradeBack",
};

function updateTrenchIsoIllustration(topWidth, bottomWidth, depth, length) {
  const hasAll = topWidth !== null && bottomWidth !== null && depth !== null && length !== null;
  const topW = hasAll ? mapClamp(topWidth, 20, 40, 140) : 100;
  const botW = hasAll ? mapClamp(bottomWidth, 20, 30, 100) : 70;
  const h = hasAll ? mapClamp(depth, 12, 25, 70) : 50;
  const runOffset = hasAll ? mapClamp(length, 100, 30, 110) : 70;

  drawIsoExcavation(TRENCH_ISO_IDS, topW, botW, h, runOffset);

  setText("isoTopLabel", topWidth !== null ? `Top width: ${roundClean(topWidth)}'` : "Top width: —");
  setText("isoBottomLabel", bottomWidth !== null ? `Bottom width: ${roundClean(bottomWidth)}'` : "Bottom width: —");
  setText("isoDepthLabel", depth !== null ? `Depth: ${roundClean(depth)}'` : "Depth: —");
  setText("isoLengthLabel", length !== null ? `Run length: ${roundClean(length)}'` : "Run length: —");
}

$("trenchViewSideBtn").addEventListener("click", () => {
  $("trenchViewSideBtn").classList.add("active");
  $("trenchViewIsoBtn").classList.remove("active");
  $("trenchSideView").hidden = false;
  $("trenchIsoView").hidden = true;
});
$("trenchViewIsoBtn").addEventListener("click", () => {
  $("trenchViewIsoBtn").classList.add("active");
  $("trenchViewSideBtn").classList.remove("active");
  $("trenchIsoView").hidden = false;
  $("trenchSideView").hidden = true;
});

let trenchWidthMode = "both"; // "both" | "slope"

function updateTrenchWidthModeUI() {
  const isSlope = trenchWidthMode === "slope";
  $("trenchWidthBothBtn").classList.toggle("active", !isSlope);
  $("trenchWidthSlopeBtn").classList.toggle("active", isSlope);
  $("trenchBothWidthFields").hidden = isSlope;
  $("trenchSlopeWidthFields").hidden = !isSlope;
}

$("trenchWidthBothBtn").addEventListener("click", () => {
  trenchWidthMode = "both";
  try {
    localStorage.setItem("gci_trench_width_mode", trenchWidthMode);
  } catch (e) {}
  updateTrenchWidthModeUI();
  computeTrench();
});
$("trenchWidthSlopeBtn").addEventListener("click", () => {
  trenchWidthMode = "slope";
  try {
    localStorage.setItem("gci_trench_width_mode", trenchWidthMode);
  } catch (e) {}
  updateTrenchWidthModeUI();
  computeTrench();
});

// Resolves the narrow/wide widths for the current mode into the same
// {topWidth, bottomWidth} shape the drawing/math code already expects —
// topWidth is always the physically-top edge, bottomWidth the physically-
// bottom edge, so a fill's crown (narrow) never ends up wider than its base.
function resolveTrenchWidths(depth) {
  if (trenchWidthMode !== "slope") {
    return { topWidth: calcVal("trench", "topWidth"), bottomWidth: calcVal("trench", "bottomWidth") };
  }
  const refWidth = calcVal("trench", "refWidth");
  const slopeRatio = calcVal("trench", "slopeRatio");
  if (refWidth === null || slopeRatio === null || depth === null) {
    setText("trenchSlopeInfo", "");
    return { topWidth: null, bottomWidth: null };
  }
  const wideWidth = refWidth + 2 * slopeRatio * Math.abs(depth);
  const isFill = depth >= 0;
  const pct = slopeRatio > 0 ? (100 / slopeRatio).toFixed(1) : "0";
  const deg = slopeRatio > 0 ? (Math.atan(1 / slopeRatio) * (180 / Math.PI)).toFixed(1) : "90";
  setText(
    "trenchSlopeInfo",
    `${slopeRatio}:1 ≈ ${pct}% slope, ${deg}° from horizontal — computed ${isFill ? "base" : "opening"} width: ${roundClean(wideWidth)}'`
  );
  return isFill ? { topWidth: refWidth, bottomWidth: wideWidth } : { topWidth: wideWidth, bottomWidth: refWidth };
}

function computeTrench() {
  const depth = calcVal("trench", "depth");
  const { topWidth, bottomWidth } = resolveTrenchWidths(depth);
  const length = calcVal("trench", "length");
  updateTrenchIllustration(topWidth, bottomWidth, depth);
  updateTrenchIsoIllustration(topWidth, bottomWidth, depth, length);
  setText("trenchLengthLabel", length !== null ? `Run length: ${roundClean(length)}'` : "Run length: —");
  if (topWidth === null || bottomWidth === null || depth === null || length === null) {
    calcLastCY.trench = null;
    setCalcResult("result-trench", "Enter dimensions");
    return;
  }
  const area = ((topWidth + bottomWidth) / 2) * Math.abs(depth);
  const cy = (area * length) / 27;
  calcLastCY.trench = cy;
  const label = depth >= 0 ? "Fill" : "Cut";
  setCalcResult(
    "result-trench",
    `${label}: <span class="big">${fmtCY(cy)} cu. yd.</span><span class="muted">Avg end area ${area.toFixed(2)} sq ft × ${roundClean(length)}' ÷ 27</span>`
  );
}

/* ---- Pad / Pond multi-point average depth ---- */

function persistGridReadings() {
  try {
    localStorage.setItem("gci_calc_grid_readings", JSON.stringify(gridReadings));
  } catch (e) {}
}

function gridPointLabel(i) {
  return i < 4 ? `Corner ${i + 1}` : i === 4 ? "Center" : `Point ${i + 1}`;
}

// Positions the first 4 readings at the corners, the 5th at center (the
// standard 5-point method), and spreads any extra points evenly around
// the footprint's perimeter so every added reading actually shows up.
function gridPointPosition(i, total) {
  const x0 = 70, x1 = 230, y0 = 20, y1 = 110;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ];
  if (i < 4) return corners[i];
  if (i === 4) return [(x0 + x1) / 2, (y0 + y1) / 2];

  const extraIndex = i - 5;
  const extraCount = Math.max(total - 5, 1);
  const w = x1 - x0;
  const h = y1 - y0;
  const perimeter = 2 * (w + h);
  const t = (extraIndex + 1) / (extraCount + 1);
  let d = t * perimeter;
  if (d < w) return [x0 + d, y0];
  d -= w;
  if (d < h) return [x1, y0 + d];
  d -= h;
  if (d < w) return [x1 - d, y1];
  d -= w;
  return [x0, y1 - d];
}

function renderGridPointsDiagram() {
  const group = $("gridPointsGroup");
  group.innerHTML = "";
  const total = gridReadings.length;
  gridReadings.forEach((val, i) => {
    const [x, y] = gridPointPosition(i, total);
    const isCenter = i === 4;
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", 4);
    dot.setAttribute("fill", val === null ? "#BFBFBF" : isCenter ? "#1F3864" : "#7B1E1E");
    group.appendChild(dot);

    if (val !== null) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", x);
      label.setAttribute("y", y - 8 < 12 ? y + 15 : y - 8);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "9");
      label.setAttribute("font-weight", "700");
      label.setAttribute("fill", isCenter ? "#1F3864" : "#7B1E1E");
      label.textContent = `${val > 0 ? "+" : ""}${roundClean(val)}'`;
      group.appendChild(label);
    }
  });
}

function renderGridReadings() {
  const wrap = $("gridReadingsList");
  wrap.innerHTML = "";
  gridReadings.forEach((val, i) => {
    const row = document.createElement("div");
    row.className = "grid-reading-row";

    const label = document.createElement("span");
    label.textContent = gridPointLabel(i);
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = calcUnitMode === "ftin" ? "e.g. 2'6\"" : unitSuffix("linear", calcUnitMode);
    input.value = val === null ? "" : formatFeetForMode(val, calcUnitMode);
    input.addEventListener("input", () => {
      gridReadings[i] = parseLengthToFeet(input.value, calcUnitMode);
      persistGridReadings();
      computeGrid();
    });
    row.appendChild(input);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "grid-reading-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this reading";
    removeBtn.addEventListener("click", () => {
      if (gridReadings.length <= 1) {
        toast("Keep at least one reading");
        return;
      }
      gridReadings.splice(i, 1);
      persistGridReadings();
      renderGridReadings();
      computeGrid();
    });
    row.appendChild(removeBtn);

    wrap.appendChild(row);
  });
}

function computeGrid() {
  renderGridPointsDiagram();
  const area = calcVal("grid", "area");
  const valid = gridReadings.filter((v) => v !== null && !Number.isNaN(v));
  if (area === null || valid.length === 0) {
    calcLastCY.grid = null;
    setCalcResult("result-grid", "Enter area &amp; at least one reading");
    setText("gridAvgLabel", "");
    return;
  }
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const cy = (area * Math.abs(avg)) / 27;
  calcLastCY.grid = cy;
  const label = avg > 0 ? "Cut" : avg < 0 ? "Fill" : "Level";
  setCalcResult(
    "result-grid",
    `${label}: <span class="big">${fmtCY(cy)} cu. yd.</span><span class="muted">Avg depth ${Math.abs(avg).toFixed(2)}' across ${valid.length} reading${valid.length === 1 ? "" : "s"} × ${area} sq ft ÷ 27</span>`
  );
  setText("gridAvgLabel", label === "Level" ? "Level — no cut/fill" : `Avg: ${Math.abs(avg).toFixed(2)}' ${label}`);
}

$("gridAddReadingBtn").addEventListener("click", () => {
  gridReadings.push(null);
  persistGridReadings();
  renderGridReadings();
  computeGrid();
});

function updateTruckFieldVisibility() {
  const ratedBy = $("truckRatedBy").value;
  $("truckCyFields").hidden = ratedBy !== "cy";
  $("truckTonFields").hidden = ratedBy !== "tons";
}

$("truckRatedBy").addEventListener("change", updateTruckFieldVisibility);

$("truckDensityPreset").addEventListener("change", () => {
  const preset = $("truckDensityPreset").value;
  if (preset === "custom") return;
  const densityInput = document.querySelector('.calc-input[data-calc="truck"][data-field="density"]');
  densityInput.value = preset;
  try {
    localStorage.setItem("gci_calc_truck_density", densityInput.value);
  } catch (e) {}
  computeTruck();
});

$("swellSoilPreset").addEventListener("change", () => {
  const preset = $("swellSoilPreset").value;
  if (preset === "custom") return;
  const [swellPct, shrinkPct] = preset.split(",");
  const swellInput = document.querySelector('.calc-input[data-calc="swell"][data-field="swellPct"]');
  const shrinkInput = document.querySelector('.calc-input[data-calc="swell"][data-field="shrinkPct"]');
  swellInput.value = swellPct;
  shrinkInput.value = shrinkPct;
  try {
    localStorage.setItem("gci_calc_swell_swellPct", swellPct);
    localStorage.setItem("gci_calc_swell_shrinkPct", shrinkPct);
  } catch (e) {}
  computeSwell();
});

function updateSwellIllustration(bankCY, swellPct, compactedCY, looseCY) {
  const refMax = Math.max(bankCY || 0, looseCY || 0, compactedCY || 0, 1);
  const bankH = mapClamp(bankCY || 0, refMax, 4, 65);
  const looseH = mapClamp(looseCY || 0, refMax, 4, 65);
  const compactedH = mapClamp(compactedCY || 0, refMax, 4, 65);
  const baseY = 105;
  setAttr("swellBarBank", "y", baseY - bankH);
  setAttr("swellBarBank", "height", bankH);
  setAttr("swellBarLoose", "y", baseY - looseH);
  setAttr("swellBarLoose", "height", looseH);
  setAttr("swellBarCompacted", "y", baseY - compactedH);
  setAttr("swellBarCompacted", "height", compactedH);
  setAttr("swellBankVal", "y", baseY - bankH - 6);
  setAttr("swellLooseVal", "y", baseY - looseH - 6);
  setAttr("swellCompactedVal", "y", baseY - compactedH - 6);
  setText("swellBankVal", bankCY ? fmtCY(bankCY) : "—");
  setText("swellLooseVal", looseCY ? fmtCY(looseCY) : "—");
  setText("swellCompactedVal", compactedCY ? fmtCY(compactedCY) : "—");
}

function computeSwell() {
  const bankCY = calcVal("swell", "bankCY");
  if (bankCY === null) {
    setCalcResult("result-swell", "Enter bank cu. yd.");
    updateSwellIllustration(0, 0, 0, 0);
    return;
  }
  const swellPct = calcVal("swell", "swellPct") || 0;
  const shrinkPct = calcVal("swell", "shrinkPct") || 0;
  const looseCY = bankCY * (1 + swellPct / 100);
  const compactedCY = bankCY * (1 - shrinkPct / 100);
  updateSwellIllustration(bankCY, swellPct, compactedCY, looseCY);
  setCalcResult(
    "result-swell",
    `<span class="big">${fmtCY(looseCY)} cu. yd. loose</span><span class="muted">for hauling — bank ${fmtCY(bankCY)} CY at ${swellPct}% swell</span>` +
      `<div style="margin-top:6px;">${fmtCY(compactedCY)} cu. yd. compacted<span class="muted">in-place fill at ${shrinkPct}% shrink</span></div>`
  );
}

function updateTruckIllustration(loads) {
  const row = document.getElementById("truckIconRow");
  const overflowLabel = document.getElementById("truckOverflowLabel");
  if (!row) return;
  row.innerHTML = "";
  if (!loads || loads <= 0) {
    overflowLabel.textContent = "";
    return;
  }
  const maxIcons = 10;
  const shown = Math.min(loads, maxIcons);
  const spacing = 26;
  for (let i = 0; i < shown; i++) {
    const x = 20 + i * spacing;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${x},30)`);
    g.innerHTML =
      '<rect x="0" y="8" width="16" height="10" rx="1.5" fill="#1F3864"/>' +
      '<rect x="14" y="4" width="8" height="14" rx="1.5" fill="#7B1E1E"/>' +
      '<circle cx="4" cy="19" r="2.5" fill="#3A3A3A"/>' +
      '<circle cx="17" cy="19" r="2.5" fill="#3A3A3A"/>';
    row.appendChild(g);
  }
  overflowLabel.textContent = loads > maxIcons ? `+${loads - maxIcons} more` : "";
}

function computeTruck() {
  const totalCY = calcVal("truck", "totalCY");
  const ratedBy = calcVal("truck", "ratedBy") || "cy";

  if (totalCY === null) {
    setCalcResult("result-truck", "Enter volume &amp; truck capacity");
    updateTruckIllustration(0);
    return;
  }

  if (ratedBy === "tons") {
    const density = calcVal("truck", "density");
    const capacityTons = calcVal("truck", "capacityTons");
    if (!density || !capacityTons) {
      setCalcResult("result-truck", "Enter volume &amp; truck capacity");
      updateTruckIllustration(0);
      return;
    }
    const totalTons = totalCY * density;
    const loads = Math.ceil(totalTons / capacityTons);
    updateTruckIllustration(loads);
    setCalcResult(
      "result-truck",
      `<span class="big">${loads} load${loads === 1 ? "" : "s"}</span><span class="muted">${fmtCY(totalCY)} CY × ${density} t/CY = ${fmtCY(totalTons)} tons ÷ ${capacityTons} tons per load</span>`
    );
    return;
  }

  const capacity = calcVal("truck", "capacity");
  if (!capacity) {
    setCalcResult("result-truck", "Enter volume &amp; truck capacity");
    updateTruckIllustration(0);
    return;
  }
  const loads = Math.ceil(totalCY / capacity);
  updateTruckIllustration(loads);
  setCalcResult(
    "result-truck",
    `<span class="big">${loads} load${loads === 1 ? "" : "s"}</span><span class="muted">${fmtCY(totalCY)} CY ÷ ${capacity} CY per load</span>`
  );
}

function updateProdIllustration(hours, hoursPerDay) {
  const barMaxW = 260;
  const dayHours = hoursPerDay || 8;
  const totalDaysShown = 5; // scale: bar track represents 5 working days
  const refMax = dayHours * totalDaysShown;
  const fillW = hours ? mapClamp(hours, refMax, 0, barMaxW) : 0;
  setAttr("prodBarFill", "width", fillW);
  setText("prodBarLabel", hours ? `${hours.toFixed(1)} hrs` : "—");
  setText("prodDayScaleLabel", `${totalDaysShown} days (${dayHours} hrs/day)`);
}

function computeProd() {
  const qty = calcVal("prod", "qty");
  const unit = calcVal("prod", "unit") || "CY";
  const rate = calcVal("prod", "rate");
  const hoursPerDay = calcVal("prod", "hoursPerDay") || 8;
  if (qty === null || rate === null || rate <= 0) {
    setCalcResult("result-prod", "Enter quantity &amp; production rate");
    updateProdIllustration(0, hoursPerDay);
    return;
  }
  const hours = qty / rate;
  const days = hours / hoursPerDay;
  updateProdIllustration(hours, hoursPerDay);
  setCalcResult(
    "result-prod",
    `<span class="big">${hours.toFixed(1)} hrs</span><span class="muted">≈ ${Math.ceil(days * 10) / 10} working days at ${hoursPerDay} hrs/day (${qty} ${unit} ÷ ${rate} ${unit}/hr)</span>`
  );
}

const CALC_FNS = {
  rect: computeRect,
  elev: computeElev,
  trench: computeTrench,
  grid: computeGrid,
  swell: computeSwell,
  truck: computeTruck,
  prod: computeProd,
};

document.querySelectorAll(".calc-input").forEach((el) => {
  el.addEventListener("input", () => {
    const { calc, field } = el.dataset;
    try {
      localStorage.setItem(`gci_calc_${calc}_${field}`, el.value);
    } catch (e) {}
    CALC_FNS[calc]();
  });
});

document.querySelectorAll(".calc-send").forEach((btn) => {
  btn.addEventListener("click", () => {
    const source = btn.dataset.source;
    const cy = calcLastCY[source];
    if (cy === null || cy === undefined) {
      toast("Calculate a volume above first");
      return;
    }
    const qtyInput = document.querySelector('.calc-input[data-calc="prod"][data-field="qty"]');
    const unitSelect = document.querySelector('.calc-input[data-calc="prod"][data-field="unit"]');
    qtyInput.value = cy.toFixed(2);
    unitSelect.value = "CY";
    try {
      localStorage.setItem("gci_calc_prod_qty", qtyInput.value);
      localStorage.setItem("gci_calc_prod_unit", unitSelect.value);
    } catch (e) {}
    computeProd();
    $("calc-prod").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Sent to Time Estimator");
  });
});

$("calcUnitMode").addEventListener("change", () => {
  const oldMode = calcUnitMode;
  const newMode = $("calcUnitMode").value;

  document.querySelectorAll(".calc-input[data-unit]").forEach((el) => {
    if (el.value === "") return;
    const unitType = el.dataset.unit;
    if (unitType === "linear") {
      const feet = parseLengthToFeet(el.value, oldMode);
      el.value = feet === null ? "" : formatFeetForMode(feet, newMode);
    } else if (unitType === "area") {
      const sqft = parseAreaToSqFt(el.value, oldMode);
      el.value = sqft === null ? "" : formatSqFtForMode(sqft, newMode);
    }
    try {
      localStorage.setItem(`gci_calc_${el.dataset.calc}_${el.dataset.field}`, el.value);
    } catch (e) {}
  });

  calcUnitMode = newMode;
  try {
    localStorage.setItem("gci_calc_unit_mode", newMode);
  } catch (e) {}

  updateDimFieldLabelsAndPlaceholders();
  renderGridReadings();
  Object.values(CALC_FNS).forEach((fn) => fn());
});

function restoreCalcInputs() {
  try {
    const storedMode = localStorage.getItem("gci_calc_unit_mode");
    if (storedMode && ["dft", "ftin", "in", "m"].includes(storedMode)) {
      calcUnitMode = storedMode;
      $("calcUnitMode").value = storedMode;
    }
  } catch (e) {}
  updateDimFieldLabelsAndPlaceholders();

  try {
    const storedTrenchMode = localStorage.getItem("gci_trench_width_mode");
    if (storedTrenchMode === "slope" || storedTrenchMode === "both") {
      trenchWidthMode = storedTrenchMode;
    }
  } catch (e) {}
  updateTrenchWidthModeUI();

  document.querySelectorAll(".calc-input").forEach((el) => {
    const { calc, field } = el.dataset;
    let stored = null;
    try {
      stored = localStorage.getItem(`gci_calc_${calc}_${field}`);
    } catch (e) {}
    if (stored !== null) el.value = stored;
  });

  try {
    const storedReadings = localStorage.getItem("gci_calc_grid_readings");
    if (storedReadings) {
      const parsed = JSON.parse(storedReadings);
      if (Array.isArray(parsed) && parsed.length > 0) gridReadings = parsed;
    }
  } catch (e) {}
  renderGridReadings();
  updateTruckFieldVisibility();

  Object.values(CALC_FNS).forEach((fn) => fn());
}

/* ---------- Calc Sheet PDF / Print ---------- */

function getCalcSectionsForPdf() {
  const sections = [];

  const length = calcVal("rect", "length");
  const width = calcVal("rect", "width");
  const rDepth = calcVal("rect", "depth");
  if (length !== null && width !== null && rDepth !== null) {
    const cy = (length * width * Math.abs(rDepth)) / 27;
    sections.push({
      title: "Rectangular Cut / Fill Volume",
      lines: [`Length: ${length} ft`, `Width: ${width} ft`, `Depth: ${rDepth} ft`],
      result: `${fmtCY(cy)} cu. yd.`,
    });
  }

  const existing = calcVal("elev", "existing");
  const proposed = calcVal("elev", "proposed");
  const eArea = calcVal("elev", "area");
  if (existing !== null && proposed !== null && eArea !== null) {
    const depth = existing - proposed;
    const cy = (eArea * Math.abs(depth)) / 27;
    const label = depth > 0 ? "Cut" : depth < 0 ? "Fill" : "Level";
    sections.push({
      title: "Depth from Elevations",
      lines: [`Existing Elev.: ${existing} ft`, `Proposed Elev.: ${proposed} ft`, `Area: ${eArea} sq ft`],
      result: `${label}: ${fmtCY(cy)} cu. yd.`,
    });
  }

  const tDepth = calcVal("trench", "depth");
  const { topWidth, bottomWidth } = resolveTrenchWidths(tDepth);
  const tLength = calcVal("trench", "length");
  if (topWidth !== null && bottomWidth !== null && tDepth !== null && tLength !== null) {
    const area = ((topWidth + bottomWidth) / 2) * Math.abs(tDepth);
    const cy = (area * tLength) / 27;
    const tLabel = tDepth >= 0 ? "Fill" : "Cut";
    const tLines = [`Top Width: ${roundClean(topWidth)} ft`, `Bottom Width: ${roundClean(bottomWidth)} ft`, `Depth: ${roundClean(Math.abs(tDepth))} ft`, `Length: ${tLength} ft`];
    if (trenchWidthMode === "slope") {
      tLines.push(`Slope mode: ${calcVal("trench", "refWidth")} ft reference @ ${calcVal("trench", "slopeRatio")}:1`);
    }
    sections.push({
      title: "Trench / Linear Cross-Section",
      lines: tLines,
      result: `${tLabel}: ${fmtCY(cy)} cu. yd.`,
    });
  }

  const gArea = calcVal("grid", "area");
  const gValidIndexed = gridReadings
    .map((v, i) => ({ v, i }))
    .filter((r) => r.v !== null && !Number.isNaN(r.v));
  if (gArea !== null && gValidIndexed.length > 0) {
    const avg = gValidIndexed.reduce((a, r) => a + r.v, 0) / gValidIndexed.length;
    const cy = (gArea * Math.abs(avg)) / 27;
    const label = avg > 0 ? "Cut" : avg < 0 ? "Fill" : "Level";
    sections.push({
      title: "Pad / Pond Avg. Depth (Multi-Point)",
      lines: [
        `Area: ${gArea} sq ft`,
        `Readings: ${gValidIndexed.map((r) => `${gridPointLabel(r.i)}: ${r.v}'`).join(", ")}`,
        `Average depth: ${avg.toFixed(2)} ft (${label})`,
      ],
      result: `${label}: ${fmtCY(cy)} cu. yd.`,
    });
  }

  const bankCY = calcVal("swell", "bankCY");
  if (bankCY !== null) {
    const swellPct = calcVal("swell", "swellPct") || 0;
    const shrinkPct = calcVal("swell", "shrinkPct") || 0;
    const soilPresetEl = document.getElementById("swellSoilPreset");
    const soilLabel =
      soilPresetEl && soilPresetEl.value !== "custom"
        ? soilPresetEl.options[soilPresetEl.selectedIndex].textContent
        : "Custom";
    const looseCY = bankCY * (1 + swellPct / 100);
    const compactedCY = bankCY * (1 - shrinkPct / 100);
    sections.push({
      title: "Bank / Loose / Compacted Conversion",
      lines: [`Soil Type: ${soilLabel}`, `Bank: ${fmtCY(bankCY)} CY`, `Swell %: ${swellPct}%`, `Shrink %: ${shrinkPct}%`],
      result: `${fmtCY(looseCY)} CY loose · ${fmtCY(compactedCY)} CY compacted`,
    });
  }

  const totalCY = calcVal("truck", "totalCY");
  const truckRatedBy = calcVal("truck", "ratedBy") || "cy";
  if (totalCY !== null && truckRatedBy === "tons") {
    const density = calcVal("truck", "density");
    const capacityTons = calcVal("truck", "capacityTons");
    if (density && capacityTons) {
      const totalTons = totalCY * density;
      const loads = Math.ceil(totalTons / capacityTons);
      sections.push({
        title: "Truck Loads Needed",
        lines: [
          `Total: ${fmtCY(totalCY)} CY`,
          `Density: ${density} tons/CY (${fmtCY(totalTons)} tons total)`,
          `Truck Capacity: ${capacityTons} tons`,
        ],
        result: `${loads} load${loads === 1 ? "" : "s"}`,
      });
    }
  } else if (totalCY !== null) {
    const capacity = calcVal("truck", "capacity");
    if (capacity) {
      const loads = Math.ceil(totalCY / capacity);
      sections.push({
        title: "Truck Loads Needed",
        lines: [`Total: ${fmtCY(totalCY)} CY`, `Truck Capacity: ${capacity} CY`],
        result: `${loads} load${loads === 1 ? "" : "s"}`,
      });
    }
  }

  const qty = calcVal("prod", "qty");
  const unit = calcVal("prod", "unit") || "CY";
  const rate = calcVal("prod", "rate");
  const hoursPerDay = calcVal("prod", "hoursPerDay") || 8;
  if (qty !== null && rate !== null && rate > 0) {
    const hours = qty / rate;
    const days = hours / hoursPerDay;
    sections.push({
      title: "Production Time Estimator",
      lines: [`Quantity: ${qty} ${unit}`, `Rate: ${rate} ${unit}/hr`, `Hours/Day: ${hoursPerDay}`],
      result: `${hours.toFixed(1)} hrs (~${Math.ceil(days * 10) / 10} days)`,
    });
  }

  return sections;
}

async function generateCalcSheetPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const logoUrl = await getLogoIconDataUrl().catch(() => null);

  function drawHeader() {
    if (logoUrl) doc.addImage(logoUrl, "PNG", marginX, 22, 22, 22);
    doc.setFont("times", "bold");
    doc.setFontSize(15);
    doc.setTextColor(123, 30, 30);
    doc.text("GILBERT CONSTRUCTION L.L.C.", marginX + 30, 34);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(89, 89, 89);
    doc.text("Excavation Takeoff & Time Estimate Sheet", marginX + 30, 47);
    doc.setDrawColor(123, 30, 30);
    doc.setLineWidth(1.5);
    doc.line(marginX, 58, pageWidth - marginX, 58);
    return 78;
  }

  function drawFooter(p, total) {
    doc.setDrawColor(217, 217, 217);
    doc.setLineWidth(0.75);
    doc.line(marginX, pageHeight - 38, pageWidth - marginX, pageHeight - 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(89, 89, 89);
    doc.text("GCI — Field Takeoff Worksheet (estimates only — verify before bid commitment)", marginX, pageHeight - 26);
    doc.text(`Page ${p} of ${total}`, pageWidth - marginX, pageHeight - 26, { align: "right" });
  }

  let y = drawHeader();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(89, 89, 89);
  doc.text(`Generated: ${new Date().toLocaleString()}`, marginX, y);
  y += 20;

  const sections = getCalcSectionsForPdf();
  if (sections.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(89, 89, 89);
    doc.text("No calculator values entered yet.", marginX, y + 10);
  } else {
    const cardW = pageWidth - marginX * 2;
    const textW = cardW - 24;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    sections.forEach((section) => {
      const wrappedLines = section.lines.map((line) => doc.splitTextToSize(line, textW));
      const lineCount = wrappedLines.reduce((n, arr) => n + arr.length, 0);
      const linesBlockH = lineCount * 13;
      const cardH = 34 + linesBlockH + 24;

      if (y + cardH > pageHeight - 50) {
        doc.addPage();
        y = drawHeader();
      }

      doc.setDrawColor(191, 191, 191);
      doc.setLineWidth(0.75);
      doc.roundedRect(marginX, y, cardW, cardH, 4, 4, "S");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(31, 56, 100);
      doc.text(section.title, marginX + 12, y + 18);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(38, 38, 38);
      let ly = y + 34;
      wrappedLines.forEach((lineArr) => {
        doc.text(lineArr, marginX + 12, ly);
        ly += 13 * lineArr.length;
      });

      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(123, 30, 30);
      doc.text(section.result, marginX + 12, ly + 12);

      y += cardH + 12;
    });
  }

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawFooter(p, totalPages);
  }
  return doc;
}

function calcSheetFilename() {
  return `GCI_Calc_Sheet_${todayISODate()}.pdf`;
}

function buildCalcPrintArea(sections) {
  const printArea = $("printArea");
  printArea.innerHTML = "";
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:14px;border-bottom:3px solid #7B1E1E;padding-bottom:12px;margin-bottom:16px;";
  header.innerHTML = `
    <img src="logo.svg" style="height:44px;" />
    <div>
      <h1 style="margin:0;font-size:20px;color:#7B1E1E;">Excavation Takeoff &amp; Time Estimate Sheet</h1>
      <div style="font-size:12px;color:#595959;">Generated ${new Date().toLocaleString()}</div>
    </div>
  `;
  printArea.appendChild(header);

  if (sections.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No calculator values entered yet.";
    printArea.appendChild(p);
    return;
  }

  sections.forEach((s) => {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #D9D9D9;border-radius:8px;padding:12px;margin-bottom:12px;break-inside:avoid;";
    card.innerHTML =
      `<div style="font-weight:700;color:#1F3864;font-size:13px;margin-bottom:6px;">${escapeHtml(s.title)}</div>` +
      s.lines.map((l) => `<div style="font-size:11px;color:#262626;">${escapeHtml(l)}</div>`).join("") +
      `<div style="font-weight:700;color:#7B1E1E;font-size:13px;margin-top:8px;">${escapeHtml(s.result)}</div>`;
    printArea.appendChild(card);
  });
}

$("downloadCalcPdfBtn").addEventListener("click", async () => {
  $("calcPdfStatus").textContent = "Generating PDF...";
  $("downloadCalcPdfBtn").disabled = true;
  try {
    const doc = await generateCalcSheetPdf();
    doc.save(calcSheetFilename());
    $("calcPdfStatus").textContent = "PDF downloaded.";
  } catch (err) {
    $("calcPdfStatus").textContent = "Couldn't generate PDF — try again.";
  } finally {
    $("downloadCalcPdfBtn").disabled = false;
  }
});

$("shareCalcPdfBtn").addEventListener("click", async () => {
  $("calcPdfStatus").textContent = "Preparing to share...";
  $("shareCalcPdfBtn").disabled = true;
  try {
    const doc = await generateCalcSheetPdf();
    const blob = doc.output("blob");
    const file = new File([blob], calcSheetFilename(), { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "GCI Excavation Takeoff Sheet", text: "Excavation takeoff & time estimate sheet attached." });
      $("calcPdfStatus").textContent = "Shared.";
    } else {
      doc.save(calcSheetFilename());
      $("calcPdfStatus").textContent = "Sharing isn't supported here — PDF downloaded instead.";
    }
  } catch (err) {
    if (err && err.name !== "AbortError") {
      $("calcPdfStatus").textContent = "Couldn't share — try downloading instead.";
    }
  } finally {
    $("shareCalcPdfBtn").disabled = false;
  }
});

$("printCalcBtn").addEventListener("click", () => {
  buildCalcPrintArea(getCalcSectionsForPdf());
  window.print();
});

/* ---------- Settings modal ---------- */

$("settingsBtn").addEventListener("click", () => {
  $("settingsModal").hidden = false;
});

$("closeSettingsBtn").addEventListener("click", () => {
  $("settingsModal").hidden = true;
});

$("settingsModal").addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") $("settingsModal").hidden = true;
});

$("settingsGoToCalcBtn").addEventListener("click", () => {
  $("settingsModal").hidden = true;
  switchTab("calc");
});

$("checkUpdateBtn").addEventListener("click", async () => {
  if (!("serviceWorker" in navigator)) {
    toast("This browser doesn't support offline updates");
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) await reg.update();
  toast("Checked for updates — reloading...");
  setTimeout(() => location.reload(), 800);
});

function clearStores(storeNames) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, "readwrite");
        storeNames.forEach((name) => tx.objectStore(name).clear());
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function clearLocalStorageCalcKeys() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("gci_calc_"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
}

$("clearEntriesBtn").addEventListener("click", async () => {
  if (!confirm("Delete ALL saved photo entries? Job sites and equipment lists are kept.\n\nThis cannot be undone.")) return;
  await clearStores(["entries"]);
  location.reload();
});

$("clearJobsBtn").addEventListener("click", async () => {
  if (!confirm("Delete the job site list? Existing photo entries keep their job name on file.\n\nThis cannot be undone.")) return;
  await clearStores(["jobs"]);
  location.reload();
});

$("resetEquipmentBtn").addEventListener("click", async () => {
  if (!confirm("Remove all equipment (including any rentals you've added) and restore the default GCI fleet list?\n\nThis cannot be undone.")) return;
  await clearStores(["equipment"]);
  location.reload();
});

$("resetCalcBtn").addEventListener("click", () => {
  if (!confirm("Clear every saved calculator input and reset units to Decimal Feet?\n\nThis cannot be undone.")) return;
  clearLocalStorageCalcKeys();
  location.reload();
});

/* ---------- Init ---------- */

async function init() {
  $("headerDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  $("reportStart").value = todayISODate();
  $("reportEnd").value = todayISODate();

  await seedIfEmpty();
  state.jobs = await idbAll("jobs");
  state.equipment = await idbAll("equipment");
  state.entries = (await idbAll("entries")).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  renderJobSelect($("jobSelect"), false);
  renderJobSelect($("historyJobFilter"), true);
  renderJobSelect($("reportJobFilter"), true);
  renderEquipmentChips();
  renderManageLists();
  updateSaveEnabled();
  restoreCalcInputs();

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
  if (isIOS && !standalone && !localStorage.getItem("gci_hideInstallHint")) {
    setTimeout(() => {
      toast("Tip: tap Share, then 'Add to Home Screen' to install");
      localStorage.setItem("gci_hideInstallHint", "1");
    }, 1200);
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

init();
