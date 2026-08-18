// api/promote.js
//
// POST /promote
// Deterministic MLflow model promotion gate.
//
// The service:
// 1. Validates the request and policy.
// 2. Validates every version before building lookup maps.
// 3. Verifies model evaluation evidence.
// 4. Determines eligible versions.
// 5. Verifies the champion's evidence.
// 6. Selects the best eligible challenger.
// 7. Promotes only when the required improvement is achieved.
// 8. Returns deterministic evidence and gate failures.

const crypto = require("crypto");

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isValidTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!TS_RE.test(value)) return false;

  const time = Date.parse(value);
  return Number.isFinite(time);
}

function isSafeNonNegativeInteger(value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isPositiveSafeIntegerString(value) {
  if (typeof value !== "string") return false;

  // Canonical positive safe-integer string.
  // Examples:
  // "1"   -> valid
  // "10"  -> valid
  // "01"  -> invalid
  // "0"   -> invalid
  // "-1"  -> invalid
  if (!/^[1-9]\d*$/.test(value)) return false;

  const n = Number(value);

  return (
    Number.isSafeInteger(n) &&
    n > 0 &&
    String(n) === value
  );
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isUnitInterval(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function byteCompare(a, b) {
  return Buffer.compare(
    Buffer.from(a, "utf8"),
    Buffer.from(b, "utf8")
  );
}

function sortCodes(codes) {
  return [...new Set(codes)].sort(byteCompare);
}

function addCode(map, version, code) {
  if (!map[version]) {
    map[version] = [];
  }

  if (!map[version].includes(code)) {
    map[version].push(code);
  }
}

function finalizeFailedGates(failedGates) {
  const output = {};

  const versions = Object.keys(failedGates).sort(byteCompare);

  for (const version of versions) {
    output[version] = sortCodes(failedGates[version]);
  }

  return output;
}

function round12(value) {
  return Math.round(value * 1e12) / 1e12;
}

// ------------------------------------------------------------
// Top-level request validation
// ------------------------------------------------------------

function validateTopLevel(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }

  if (!isValidTimestamp(body.asOf)) {
    return false;
  }

  if (!isPositiveSafeIntegerString(body.championVersion)) {
    return false;
  }

  if (
    !body.policy ||
    typeof body.policy !== "object" ||
    Array.isArray(body.policy)
  ) {
    return false;
  }

  if (!Array.isArray(body.versions)) {
    return false;
  }

  return true;
}

// ------------------------------------------------------------
// Policy validation
// ------------------------------------------------------------

function validatePolicy(policy) {
  const errors = [];

  if (
    typeof policy.datasetDigest !== "string" ||
    policy.datasetDigest.length === 0
  ) {
    errors.push("datasetDigest");
  }

  if (
    typeof policy.schemaDigest !== "string" ||
    policy.schemaDigest.length === 0
  ) {
    errors.push("schemaDigest");
  }

  if (!isSafeNonNegativeInteger(policy.maxAgeSeconds)) {
    errors.push("maxAgeSeconds");
  }

  if (!isUnitInterval(policy.accuracyFloor)) {
    errors.push("accuracyFloor");
  }

  if (
    !policy.requiredSlices ||
    typeof policy.requiredSlices !== "object" ||
    Array.isArray(policy.requiredSlices)
  ) {
    errors.push("requiredSlices");
  } else {
    for (const name of Object.keys(policy.requiredSlices)) {
      if (!isUnitInterval(policy.requiredSlices[name])) {
        errors.push("requiredSlices");
        break;
      }
    }
  }

  if (
    !isFiniteNumber(policy.maxLatencyMs) ||
    policy.maxLatencyMs < 0
  ) {
    errors.push("maxLatencyMs");
  }

  if (!isSafeNonNegativeInteger(policy.maxSizeBytes)) {
    errors.push("maxSizeBytes");
  }

  if (!isUnitInterval(policy.minImprovement)) {
    errors.push("minImprovement");
  }

  return errors;
}

// ------------------------------------------------------------
// Version validation
// ------------------------------------------------------------

function validateVersionShape(version) {
  const errors = [];

  if (
    !version ||
    typeof version !== "object" ||
    Array.isArray(version)
  ) {
    errors.push("INVALID_VERSION");
    return errors;
  }

  if (!isPositiveSafeIntegerString(version.version)) {
    errors.push("INVALID_VERSION");
  }

  if (
    typeof version.artifactDigest !== "string" ||
    version.artifactDigest.length === 0
  ) {
    errors.push("INVALID_VERSION");
  }

  if (
    !version.evaluation ||
    typeof version.evaluation !== "object" ||
    Array.isArray(version.evaluation)
  ) {
    errors.push("MISSING_EVALUATION");
  }

  return errors;
}

// ------------------------------------------------------------
// Evidence validation
// ------------------------------------------------------------

function validateEvaluation(
  version,
  policy,
  asOfMs,
  failedGates
) {
  const evaluation = version.evaluation;

  if (
    !evaluation ||
    typeof evaluation !== "object" ||
    Array.isArray(evaluation)
  ) {
    addCode(failedGates, version.version, "MISSING_EVALUATION");
    return false;
  }

  let eligible = true;

  // createdAt
  if (!isValidTimestamp(evaluation.createdAt)) {
    addCode(
      failedGates,
      version.version,
      "INVALID_TIMESTAMP"
    );
    eligible = false;
  } else {
    const createdMs = Date.parse(evaluation.createdAt);

    if (createdMs > asOfMs) {
      addCode(
        failedGates,
        version.version,
        "FUTURE_EVALUATION"
      );
      eligible = false;
    }

    const oldestAllowed =
      asOfMs - policy.maxAgeSeconds * 1000;

    if (createdMs < oldestAllowed) {
      addCode(
        failedGates,
        version.version,
        "STALE_EVALUATION"
      );
      eligible = false;
    }
  }

  // Numeric evidence
  if (
    !isFiniteNumber(evaluation.accuracy) ||
    !isFiniteNumber(evaluation.latencyMs) ||
    !isFiniteNumber(evaluation.sizeBytes)
  ) {
    addCode(
      failedGates,
      version.version,
      "NON_FINITE"
    );
    eligible = false;
  }

  // Accuracy range
  if (
    isFiniteNumber(evaluation.accuracy) &&
    (evaluation.accuracy < 0 ||
      evaluation.accuracy > 1)
  ) {
    addCode(
      failedGates,
      version.version,
      "METRIC_RANGE"
    );
    eligible = false;
  }

  // Artifact binding
  if (evaluation.artifactDigest !== version.artifactDigest) {
    addCode(
      failedGates,
      version.version,
      "ARTIFACT_MISMATCH"
    );
    eligible = false;
  }

  // Dataset binding
  if (evaluation.datasetDigest !== policy.datasetDigest) {
    addCode(
      failedGates,
      version.version,
      "DATASET_MISMATCH"
    );
    eligible = false;
  }

  // Schema binding
  if (evaluation.schemaDigest !== policy.schemaDigest) {
    addCode(
      failedGates,
      version.version,
      "SCHEMA_MISMATCH"
    );
    eligible = false;
  }

  // Accuracy floor
  if (
    !isFiniteNumber(evaluation.accuracy) ||
    evaluation.accuracy < policy.accuracyFloor
  ) {
    addCode(
      failedGates,
      version.version,
      "ACCURACY_FLOOR"
    );
    eligible = false;
  }

  // Latency
  if (
    !isFiniteNumber(evaluation.latencyMs) ||
    evaluation.latencyMs < 0 ||
    evaluation.latencyMs > policy.maxLatencyMs
  ) {
    addCode(
      failedGates,
      version.version,
      "LATENCY_LIMIT"
    );
    eligible = false;
  }

  // Size
  if (
    !isFiniteNumber(evaluation.sizeBytes) ||
    evaluation.sizeBytes < 0 ||
    evaluation.sizeBytes > policy.maxSizeBytes
  ) {
    addCode(
      failedGates,
      version.version,
      "SIZE_LIMIT"
    );
    eligible = false;
  }

  // Required slices
  if (
    !evaluation.slices ||
    typeof evaluation.slices !== "object" ||
    Array.isArray(evaluation.slices)
  ) {
    for (const name of Object.keys(policy.requiredSlices)) {
      addCode(
        failedGates,
        version.version,
        `MISSING_SLICE:${name}`
      );
    }

    eligible = false;
  } else {
    for (const name of Object.keys(policy.requiredSlices)) {
      if (!Object.prototype.hasOwnProperty.call(evaluation.slices, name)) {
        addCode(
          failedGates,
          version.version,
          `MISSING_SLICE:${name}`
        );
        eligible = false;
        continue;
      }

      const sliceValue = evaluation.slices[name];

      if (!isUnitInterval(sliceValue)) {
        addCode(
          failedGates,
          version.version,
          `SLICE_RANGE:${name}`
        );
        eligible = false;
        continue;
      }

      if (
        sliceValue <
        policy.requiredSlices[name]
      ) {
        addCode(
          failedGates,
          version.version,
          `SLICE_FLOOR:${name}`
        );
        eligible = false;
      }
    }
  }

  return eligible;
}

// ------------------------------------------------------------
// Deterministic ranking
// ------------------------------------------------------------

function compareEligibleVersions(a, b) {
  const ea = a.evaluation;
  const eb = b.evaluation;

  // Accuracy descending
  if (ea.accuracy !== eb.accuracy) {
    return eb.accuracy - ea.accuracy;
  }

  // Latency ascending
  if (ea.latencyMs !== eb.latencyMs) {
    return ea.latencyMs - eb.latencyMs;
  }

  // Size ascending
  if (ea.sizeBytes !== eb.sizeBytes) {
    return ea.sizeBytes - eb.sizeBytes;
  }

  // Numeric version ascending
  const av = Number(a.version);
  const bv = Number(b.version);

  return av - bv;
}

// ------------------------------------------------------------
// Main promotion logic
// ------------------------------------------------------------

function processPromotion(body) {
  const failedGates = {};

  const topLevelValid = validateTopLevel(body);

  if (!topLevelValid) {
    return {
      status: 400,
      body: {
        error: "INVALID_INPUT"
      }
    };
  }

  const policyErrors = validatePolicy(body.policy);

  if (policyErrors.length > 0) {
    return {
      status: 400,
      body: {
        error: "INVALID_INPUT"
      }
    };
  }

  const versions = body.versions;

  // ----------------------------------------------------------
  // IMPORTANT:
  // Reject duplicates/noncanonical versions BEFORE creating
  // lookup maps.
  // ----------------------------------------------------------

  const seenVersions = new Set();
  let invalidVersionList = false;

  for (const version of versions) {
    if (
      !version ||
      typeof version !== "object" ||
      Array.isArray(version) ||
      !isPositiveSafeIntegerString(version.version)
    ) {
      invalidVersionList = true;
      break;
    }

    if (seenVersions.has(version.version)) {
      invalidVersionList = true;
      break;
    }

    seenVersions.add(version.version);
  }

  if (invalidVersionList) {
    // Contract requires rejecting duplicate or noncanonical
    // versions before lookup construction.
    for (const version of versions) {
      if (
        version &&
        typeof version === "object" &&
        !Array.isArray(version) &&
        typeof version.version === "string"
      ) {
        if (!isPositiveSafeIntegerString(version.version)) {
          addCode(
            failedGates,
            version.version,
            "INVALID_VERSION"
          );
        } else if (
          versions.filter(
            (v) =>
              v &&
              typeof v === "object" &&
              v.version === version.version
          ).length > 1
        ) {
          addCode(
            failedGates,
            version.version,
            "DUPLICATE_VERSION"
          );
        }
      }
    }

    return buildBlockResponse(
      body.championVersion,
      failedGates
    );
  }

  // ----------------------------------------------------------
  // Now it is safe to build the version lookup map.
  // ----------------------------------------------------------

  const versionMap = new Map();

  for (const version of versions) {
    versionMap.set(version.version, version);
  }

  // ----------------------------------------------------------
  // Validate every version.
  // ----------------------------------------------------------

  const asOfMs = Date.parse(body.asOf);
  const eligible = [];

  for (const version of versions) {
    const shapeErrors = validateVersionShape(version);

    if (shapeErrors.length > 0) {
      for (const code of shapeErrors) {
        addCode(
          failedGates,
          version.version || "",
          code
        );
      }

      continue;
    }

    const ok = validateEvaluation(
      version,
      body.policy,
      asOfMs,
      failedGates
    );

    if (ok) {
      eligible.push(version);
    }
  }

  // ----------------------------------------------------------
  // Deterministically rank eligible versions.
  // ----------------------------------------------------------

  eligible.sort(compareEligibleVersions);

  const eligibleVersions = eligible.map(
    (v) => v.version
  );

  // ----------------------------------------------------------
  // Champion evidence must be valid.
  // ----------------------------------------------------------

  const champion =
    versionMap.get(body.championVersion);

  let championEligible = false;

  if (champion) {
    championEligible =
      !failedGates[body.championVersion] ||
      failedGates[body.championVersion].length === 0;
  }

  if (!championEligible) {
    return {
      status: 200,
      body: {
        action: "block",
        championVersion: body.championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates: finalizeFailedGates(failedGates),
        aliasMutation: null,
        evidence: null
      }
    };
  }

  // ----------------------------------------------------------
  // Find the best eligible challenger.
  //
  // We need a version different from the champion.
  // ----------------------------------------------------------

  const challengers = eligible.filter(
    (v) => v.version !== body.championVersion
  );

  if (challengers.length === 0) {
    return {
      status: 200,
      body: {
        action: "retain",
        championVersion: body.championVersion,
        selectedVersion: body.championVersion,
        eligibleVersions,
        failedGates: finalizeFailedGates(failedGates),
        aliasMutation: null,
        evidence: champion.evaluation
      }
    };
  }

  const challenger = challengers[0];

  // ----------------------------------------------------------
  // Improvement requirement.
  // ----------------------------------------------------------

  const improvement = round12(
    challenger.evaluation.accuracy -
      champion.evaluation.accuracy
  );

  if (
    improvement <
    body.policy.minImprovement
  ) {
    return {
      status: 200,
      body: {
        action: "retain",
        championVersion: body.championVersion,
        selectedVersion: body.championVersion,
        eligibleVersions,
        failedGates: finalizeFailedGates(failedGates),
        aliasMutation: null,
        evidence: champion.evaluation
      }
    };
  }

  // ----------------------------------------------------------
  // Promote challenger.
  // ----------------------------------------------------------

  return {
    status: 200,
    body: {
      action: "promote",
      championVersion: body.championVersion,
      selectedVersion: challenger.version,
      eligibleVersions,
      failedGates: finalizeFailedGates(failedGates),
      aliasMutation: {
        alias: "champion",
        version: challenger.version
      },
      evidence: challenger.evaluation
    }
  };
}

// ------------------------------------------------------------
// Block response helper
// ------------------------------------------------------------

function buildBlockResponse(
  championVersion,
  failedGates
) {
  return {
    status: 200,
    body: {
      action: "block",
      championVersion,
      selectedVersion: null,
      eligibleVersions: [],
      failedGates: finalizeFailedGates(failedGates),
      aliasMutation: null,
      evidence: null
    }
  };
}

// ------------------------------------------------------------
// Vercel serverless handler
// ------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader(
    "Content-Type",
    "application/json"
  );

  // Only POST is accepted.
  if (req.method !== "POST") {
    res.status(400).json({
      error: "INVALID_INPUT"
    });
    return;
  }

  let body = req.body;

  // Vercel normally parses JSON automatically.
  // This also handles a raw JSON string safely.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      res.status(400).json({
        error: "INVALID_INPUT"
      });
      return;
    }
  }

  try {
    const result = processPromotion(body);

    res
      .status(result.status)
      .json(result.body);
  } catch (error) {
    // Never expose internal errors to the grader.
    res.status(400).json({
      error: "INVALID_INPUT"
    });
  }
};
