// api/promote.js

const TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isTimestamp(x) {
  if (typeof x !== "string" || !TS_RE.test(x)) return false;
  return Number.isFinite(Date.parse(x));
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function isUnitNumber(x) {
  return isFiniteNumber(x) && x >= 0 && x <= 1;
}

function isSafeNonNegativeInteger(x) {
  return (
    typeof x === "number" &&
    Number.isSafeInteger(x) &&
    x >= 0
  );
}

function isCanonicalVersion(x) {
  if (typeof x !== "string") return false;
  if (!/^[1-9]\d*$/.test(x)) return false;

  const n = Number(x);

  return (
    Number.isSafeInteger(n) &&
    n > 0 &&
    String(n) === x
  );
}

function byteCompare(a, b) {
  return Buffer.compare(
    Buffer.from(a, "utf8"),
    Buffer.from(b, "utf8")
  );
}

function sortedUniqueCodes(codes) {
  return [...new Set(codes)].sort(byteCompare);
}

function addFailure(failedGates, version, code) {
  if (!failedGates[version]) {
    failedGates[version] = [];
  }

  failedGates[version].push(code);
}

function cleanFailedGates(failedGates) {
  const result = {};

  for (const version of Object.keys(failedGates).sort(byteCompare)) {
    result[version] = sortedUniqueCodes(
      failedGates[version]
    );
  }

  return result;
}

function round12(x) {
  return Math.round(x * 1e12) / 1e12;
}


// ------------------------------------------------------------
// Request-level validation
// ------------------------------------------------------------

function validRequestShape(body) {
  if (!isObject(body)) return false;

  if (!isTimestamp(body.asOf)) return false;

  if (!isCanonicalVersion(body.championVersion)) {
    return false;
  }

  if (!isObject(body.policy)) return false;

  if (!Array.isArray(body.versions)) return false;

  return true;
}


// ------------------------------------------------------------
// Policy validation
// ------------------------------------------------------------

function validPolicy(policy) {
  if (
    typeof policy.datasetDigest !== "string" ||
    policy.datasetDigest.length === 0
  ) {
    return false;
  }

  if (
    typeof policy.schemaDigest !== "string" ||
    policy.schemaDigest.length === 0
  ) {
    return false;
  }

  if (!isSafeNonNegativeInteger(policy.maxAgeSeconds)) {
    return false;
  }

  if (!isUnitNumber(policy.accuracyFloor)) {
    return false;
  }

  if (
    !isObject(policy.requiredSlices)
  ) {
    return false;
  }

  for (const name of Object.keys(policy.requiredSlices)) {
    if (!isUnitNumber(policy.requiredSlices[name])) {
      return false;
    }
  }

  if (
    !isFiniteNumber(policy.maxLatencyMs) ||
    policy.maxLatencyMs < 0
  ) {
    return false;
  }

  if (!isSafeNonNegativeInteger(policy.maxSizeBytes)) {
    return false;
  }

  if (!isUnitNumber(policy.minImprovement)) {
    return false;
  }

  return true;
}


// ------------------------------------------------------------
// Version validation
// ------------------------------------------------------------

function versionShapeErrors(version) {
  const errors = [];

  if (!isObject(version)) {
    errors.push("INVALID_VERSION");
    return errors;
  }

  if (!isCanonicalVersion(version.version)) {
    errors.push("INVALID_VERSION");
  }

  if (
    typeof version.artifactDigest !== "string" ||
    version.artifactDigest.length === 0
  ) {
    errors.push("INVALID_VERSION");
  }

  if (!isObject(version.evaluation)) {
    errors.push("MISSING_EVALUATION");
  }

  return errors;
}


// ------------------------------------------------------------
// Evaluation evidence
// ------------------------------------------------------------

function evaluateVersion(
  version,
  policy,
  asOfMs,
  failedGates
) {
  const id = version.version;
  const ev = version.evaluation;

  if (!isObject(ev)) {
    addFailure(
      failedGates,
      id,
      "MISSING_EVALUATION"
    );
    return false;
  }

  let eligible = true;

  // createdAt
  if (!isTimestamp(ev.createdAt)) {
    addFailure(
      failedGates,
      id,
      "INVALID_TIMESTAMP"
    );
    eligible = false;
  } else {
    const createdMs = Date.parse(ev.createdAt);

    if (createdMs > asOfMs) {
      addFailure(
        failedGates,
        id,
        "FUTURE_EVALUATION"
      );
      eligible = false;
    }

    const oldest =
      asOfMs -
      policy.maxAgeSeconds * 1000;

    if (createdMs < oldest) {
      addFailure(
        failedGates,
        id,
        "STALE_EVALUATION"
      );
      eligible = false;
    }
  }

  // Numeric evidence
  if (
    !isFiniteNumber(ev.accuracy) ||
    !isFiniteNumber(ev.latencyMs) ||
    !isFiniteNumber(ev.sizeBytes)
  ) {
    addFailure(
      failedGates,
      id,
      "NON_FINITE"
    );
    eligible = false;
  }

  // Accuracy range
  if (
    isFiniteNumber(ev.accuracy) &&
    (ev.accuracy < 0 || ev.accuracy > 1)
  ) {
    addFailure(
      failedGates,
      id,
      "METRIC_RANGE"
    );
    eligible = false;
  }

  // Artifact lineage
  if (ev.artifactDigest !== version.artifactDigest) {
    addFailure(
      failedGates,
      id,
      "ARTIFACT_MISMATCH"
    );
    eligible = false;
  }

  // Dataset lineage
  if (ev.datasetDigest !== policy.datasetDigest) {
    addFailure(
      failedGates,
      id,
      "DATASET_MISMATCH"
    );
    eligible = false;
  }

  // Schema lineage
  if (ev.schemaDigest !== policy.schemaDigest) {
    addFailure(
      failedGates,
      id,
      "SCHEMA_MISMATCH"
    );
    eligible = false;
  }

  // Accuracy gate
  if (
    !isFiniteNumber(ev.accuracy) ||
    ev.accuracy < policy.accuracyFloor
  ) {
    addFailure(
      failedGates,
      id,
      "ACCURACY_FLOOR"
    );
    eligible = false;
  }

  // Latency gate
  if (
    !isFiniteNumber(ev.latencyMs) ||
    ev.latencyMs < 0 ||
    ev.latencyMs > policy.maxLatencyMs
  ) {
    addFailure(
      failedGates,
      id,
      "LATENCY_LIMIT"
    );
    eligible = false;
  }

  // Size gate
  if (
    !isSafeNonNegativeInteger(ev.sizeBytes) ||
    ev.sizeBytes > policy.maxSizeBytes
  ) {
    addFailure(
      failedGates,
      id,
      "SIZE_LIMIT"
    );
    eligible = false;
  }

  // Slice gates
  if (!isObject(ev.slices)) {
    for (const name of Object.keys(
      policy.requiredSlices
    )) {
      addFailure(
        failedGates,
        id,
        `MISSING_SLICE:${name}`
      );
    }

    eligible = false;
  } else {
    for (const name of Object.keys(
      policy.requiredSlices
    )) {
      if (
        !Object.prototype.hasOwnProperty.call(
          ev.slices,
          name
        )
      ) {
        addFailure(
          failedGates,
          id,
          `MISSING_SLICE:${name}`
        );
        eligible = false;
        continue;
      }

      const value = ev.slices[name];

      if (!isUnitNumber(value)) {
        addFailure(
          failedGates,
          id,
          `SLICE_RANGE:${name}`
        );
        eligible = false;
        continue;
      }

      if (
        value <
        policy.requiredSlices[name]
      ) {
        addFailure(
          failedGates,
          id,
          `SLICE_FLOOR:${name}`
        );
        eligible = false;
      }
    }
  }

  return eligible;
}


// ------------------------------------------------------------
// Ranking
// ------------------------------------------------------------

function compareVersions(a, b) {
  const ae = a.evaluation;
  const be = b.evaluation;

  // Accuracy descending
  if (ae.accuracy !== be.accuracy) {
    return be.accuracy - ae.accuracy;
  }

  // Latency ascending
  if (ae.latencyMs !== be.latencyMs) {
    return ae.latencyMs - be.latencyMs;
  }

  // Size ascending
  if (ae.sizeBytes !== be.sizeBytes) {
    return ae.sizeBytes - be.sizeBytes;
  }

  // Version ascending numerically
  return Number(a.version) - Number(b.version);
}


// ------------------------------------------------------------
// Main logic
// ------------------------------------------------------------

function promote(body) {
  // Required HTTP 400 cases
  if (!validRequestShape(body)) {
    return {
      status: 400,
      body: {
        error: "INVALID_INPUT"
      }
    };
  }

  if (!validPolicy(body.policy)) {
    return {
      status: 400,
      body: {
        error: "INVALID_INPUT"
      }
    };
  }

  const failedGates = {};

  // ----------------------------------------------------------
  // Check duplicates/noncanonical versions BEFORE lookup map
  // ----------------------------------------------------------

  const seen = new Set();
  let contractFailure = false;

  for (const version of body.versions) {
    if (!isObject(version)) {
      contractFailure = true;
      continue;
    }

    const id = version.version;

    if (!isCanonicalVersion(id)) {
      contractFailure = true;
      addFailure(
        failedGates,
        String(id),
        "INVALID_VERSION"
      );
      continue;
    }

    if (seen.has(id)) {
      contractFailure = true;
      addFailure(
        failedGates,
        id,
        "DUPLICATE_VERSION"
      );
    }

    seen.add(id);
  }

  if (contractFailure) {
    return {
      status: 200,
      body: {
        action: "block",
        championVersion: body.championVersion,
        selectedVersion: null,
        eligibleVersions: [],
        failedGates: cleanFailedGates(
          failedGates
        ),
        aliasMutation: null,
        evidence: null
      }
    };
  }

  // ----------------------------------------------------------
  // Build lookup map only after duplicate checks
  // ----------------------------------------------------------

  const versionsById = new Map();

  for (const version of body.versions) {
    versionsById.set(
      version.version,
      version
    );
  }

  const asOfMs = Date.parse(body.asOf);

  const eligible = [];

  // ----------------------------------------------------------
  // Check every version
  // ----------------------------------------------------------

  for (const version of body.versions) {
    const shapeErrors =
      versionShapeErrors(version);

    if (shapeErrors.length > 0) {
      for (const code of shapeErrors) {
        addFailure(
          failedGates,
          version.version,
          code
        );
      }

      continue;
    }

    const ok = evaluateVersion(
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
  // Sort eligible versions
  // ----------------------------------------------------------

  eligible.sort(compareVersions);

  const eligibleVersions =
    eligible.map((v) => v.version);

  // ----------------------------------------------------------
  // Champion must exist and have valid evidence
  // ----------------------------------------------------------

  const champion =
    versionsById.get(
      body.championVersion
    );

  if (!champion) {
    return {
      status: 200,
      body: {
        action: "block",
        championVersion:
          body.championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates: cleanFailedGates(
          failedGates
        ),
        aliasMutation: null,
        evidence: null
      }
    };
  }

  const championFailures =
    failedGates[
      body.championVersion
    ] || [];

  if (championFailures.length > 0) {
    return {
      status: 200,
      body: {
        action: "block",
        championVersion:
          body.championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates: cleanFailedGates(
          failedGates
        ),
        aliasMutation: null,
        evidence: null
      }
    };
  }

  // ----------------------------------------------------------
  // Best eligible challenger
  // ----------------------------------------------------------

  const challengers =
    eligible.filter(
      (v) =>
        v.version !==
        body.championVersion
    );

  // No challenger
  if (challengers.length === 0) {
    return {
      status: 200,
      body: {
        action: "retain",
        championVersion:
          body.championVersion,
        selectedVersion:
          body.championVersion,
        eligibleVersions,
        failedGates: cleanFailedGates(
          failedGates
        ),
        aliasMutation: null,
        evidence:
          champion.evaluation
      }
    };
  }

  const challenger =
    challengers[0];

  // ----------------------------------------------------------
  // Improvement
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
        championVersion:
          body.championVersion,
        selectedVersion:
          body.championVersion,
        eligibleVersions,
        failedGates: cleanFailedGates(
          failedGates
        ),
        aliasMutation: null,
        evidence:
          champion.evaluation
      }
    };
  }

  // ----------------------------------------------------------
  // Promote
  // ----------------------------------------------------------

  return {
    status: 200,
    body: {
      action: "promote",
      championVersion:
        body.championVersion,
      selectedVersion:
        challenger.version,
      eligibleVersions,
      failedGates: cleanFailedGates(
        failedGates
      ),
      aliasMutation: {
        alias: "champion",
        version: challenger.version
      },
      evidence:
        challenger.evaluation
    }
  };
}


// ------------------------------------------------------------
// Vercel handler
// ------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader(
    "Content-Type",
    "application/json"
  );

  if (req.method !== "POST") {
    res.status(400).json({
      error: "INVALID_INPUT"
    });
    return;
  }

  let body = req.body;

  // Handle environments where body arrives as text.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({
        error: "INVALID_INPUT"
      });
      return;
    }
  }

  const result = promote(body);

  res
    .status(result.status)
    .json(result.body);
};
