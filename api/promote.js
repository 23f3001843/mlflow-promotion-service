// api/promote.js

const TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;


// ============================================================
// BASIC HELPERS
// ============================================================

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isValidTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!TS_RE.test(value)) return false;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function isUnitNumber(value) {
  return (
    isFiniteNumber(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isSafeNonNegativeInteger(value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isCanonicalVersion(value) {
  if (typeof value !== "string") return false;

  // Must be:
  // "1"
  // "2"
  // "123"
  //
  // NOT:
  // "01"
  // "0"
  // "-1"
  // "1.0"
  if (!/^[1-9][0-9]*$/.test(value)) {
    return false;
  }

  const numberValue = Number(value);

  return (
    Number.isSafeInteger(numberValue) &&
    numberValue > 0 &&
    String(numberValue) === value
  );
}

function byteCompare(a, b) {
  return Buffer.compare(
    Buffer.from(String(a), "utf8"),
    Buffer.from(String(b), "utf8")
  );
}

function uniqueSortedCodes(codes) {
  return [...new Set(codes)].sort(byteCompare);
}

function addFailure(failedGates, version, code) {
  const key = String(version);

  if (!failedGates[key]) {
    failedGates[key] = [];
  }

  if (!failedGates[key].includes(code)) {
    failedGates[key].push(code);
  }
}

function finalizeFailedGates(failedGates) {
  const result = {};

  const versions = Object.keys(failedGates).sort(
    byteCompare
  );

  for (const version of versions) {
    result[version] =
      uniqueSortedCodes(failedGates[version]);
  }

  return result;
}

function round12(value) {
  return Math.round(value * 1e12) / 1e12;
}


// ============================================================
// TOP LEVEL VALIDATION
// ============================================================

function validateRequest(body) {
  if (!isObject(body)) {
    return false;
  }

  if (!isValidTimestamp(body.asOf)) {
    return false;
  }

  if (!isCanonicalVersion(body.championVersion)) {
    return false;
  }

  if (!isObject(body.policy)) {
    return false;
  }

  if (!Array.isArray(body.versions)) {
    return false;
  }

  return true;
}


// ============================================================
// POLICY VALIDATION
// ============================================================

function validatePolicy(policy) {
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

  if (
    !isSafeNonNegativeInteger(
      policy.maxAgeSeconds
    )
  ) {
    return false;
  }

  if (!isUnitNumber(policy.accuracyFloor)) {
    return false;
  }

  if (!isObject(policy.requiredSlices)) {
    return false;
  }

  for (
    const name of Object.keys(
      policy.requiredSlices
    )
  ) {
    if (
      !isUnitNumber(
        policy.requiredSlices[name]
      )
    ) {
      return false;
    }
  }

  if (
    !isFiniteNumber(policy.maxLatencyMs) ||
    policy.maxLatencyMs < 0
  ) {
    return false;
  }

  if (
    !isSafeNonNegativeInteger(
      policy.maxSizeBytes
    )
  ) {
    return false;
  }

  if (!isUnitNumber(policy.minImprovement)) {
    return false;
  }

  return true;
}


// ============================================================
// VERSION SHAPE
// ============================================================

function validateVersionShape(version) {
  const errors = [];

  if (!isObject(version)) {
    return ["INVALID_VERSION"];
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


// ============================================================
// EVIDENCE CHECK
// ============================================================

function checkEvidence(
  version,
  policy,
  asOfMs,
  failedGates
) {
  const versionId = String(version.version);
  const evaluation = version.evaluation;

  if (!isObject(evaluation)) {
    addFailure(
      failedGates,
      versionId,
      "MISSING_EVALUATION"
    );

    return false;
  }

  let eligible = true;


  // ----------------------------------------------------------
  // Timestamp
  // ----------------------------------------------------------

  if (!isValidTimestamp(evaluation.createdAt)) {
    addFailure(
      failedGates,
      versionId,
      "INVALID_TIMESTAMP"
    );

    eligible = false;
  } else {
    const createdAtMs =
      Date.parse(evaluation.createdAt);

    if (createdAtMs > asOfMs) {
      addFailure(
        failedGates,
        versionId,
        "FUTURE_EVALUATION"
      );

      eligible = false;
    }

    const earliestAllowed =
      asOfMs -
      policy.maxAgeSeconds * 1000;

    if (createdAtMs < earliestAllowed) {
      addFailure(
        failedGates,
        versionId,
        "STALE_EVALUATION"
      );

      eligible = false;
    }
  }


  // ----------------------------------------------------------
  // Numeric evidence
  // ----------------------------------------------------------

  if (
    !isFiniteNumber(evaluation.accuracy) ||
    !isFiniteNumber(evaluation.latencyMs) ||
    !isFiniteNumber(evaluation.sizeBytes)
  ) {
    addFailure(
      failedGates,
      versionId,
      "NON_FINITE"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Accuracy range
  // ----------------------------------------------------------

  if (
    isFiniteNumber(evaluation.accuracy) &&
    (
      evaluation.accuracy < 0 ||
      evaluation.accuracy > 1
    )
  ) {
    addFailure(
      failedGates,
      versionId,
      "METRIC_RANGE"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Artifact lineage
  // ----------------------------------------------------------

  if (
    evaluation.artifactDigest !==
    version.artifactDigest
  ) {
    addFailure(
      failedGates,
      versionId,
      "ARTIFACT_MISMATCH"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Dataset lineage
  // ----------------------------------------------------------

  if (
    evaluation.datasetDigest !==
    policy.datasetDigest
  ) {
    addFailure(
      failedGates,
      versionId,
      "DATASET_MISMATCH"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Schema lineage
  // ----------------------------------------------------------

  if (
    evaluation.schemaDigest !==
    policy.schemaDigest
  ) {
    addFailure(
      failedGates,
      versionId,
      "SCHEMA_MISMATCH"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Accuracy floor
  // ----------------------------------------------------------

  if (
    !isFiniteNumber(evaluation.accuracy) ||
    evaluation.accuracy <
      policy.accuracyFloor
  ) {
    addFailure(
      failedGates,
      versionId,
      "ACCURACY_FLOOR"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Latency limit
  // ----------------------------------------------------------

  if (
    !isFiniteNumber(evaluation.latencyMs) ||
    evaluation.latencyMs < 0 ||
    evaluation.latencyMs >
      policy.maxLatencyMs
  ) {
    addFailure(
      failedGates,
      versionId,
      "LATENCY_LIMIT"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Size limit
  // ----------------------------------------------------------

  if (
    !isSafeNonNegativeInteger(
      evaluation.sizeBytes
    ) ||
    evaluation.sizeBytes >
      policy.maxSizeBytes
  ) {
    addFailure(
      failedGates,
      versionId,
      "SIZE_LIMIT"
    );

    eligible = false;
  }


  // ----------------------------------------------------------
  // Required slices
  // ----------------------------------------------------------

  if (!isObject(evaluation.slices)) {
    for (
      const sliceName of Object.keys(
        policy.requiredSlices
      )
    ) {
      addFailure(
        failedGates,
        versionId,
        `MISSING_SLICE:${sliceName}`
      );
    }

    eligible = false;
  } else {
    for (
      const sliceName of Object.keys(
        policy.requiredSlices
      )
    ) {
      if (
        !Object.prototype.hasOwnProperty.call(
          evaluation.slices,
          sliceName
        )
      ) {
        addFailure(
          failedGates,
          versionId,
          `MISSING_SLICE:${sliceName}`
        );

        eligible = false;
        continue;
      }

      const sliceValue =
        evaluation.slices[sliceName];

      if (!isUnitNumber(sliceValue)) {
        addFailure(
          failedGates,
          versionId,
          `SLICE_RANGE:${sliceName}`
        );

        eligible = false;
        continue;
      }

      if (
        sliceValue <
        policy.requiredSlices[sliceName]
      ) {
        addFailure(
          failedGates,
          versionId,
          `SLICE_FLOOR:${sliceName}`
        );

        eligible = false;
      }
    }
  }

  return eligible;
}


// ============================================================
// RANKING
// ============================================================

function compareEligible(a, b) {
  const aEval = a.evaluation;
  const bEval = b.evaluation;

  // 1. Accuracy descending
  if (
    aEval.accuracy !==
    bEval.accuracy
  ) {
    return (
      bEval.accuracy -
      aEval.accuracy
    );
  }

  // 2. Latency ascending
  if (
    aEval.latencyMs !==
    bEval.latencyMs
  ) {
    return (
      aEval.latencyMs -
      bEval.latencyMs
    );
  }

  // 3. Size ascending
  if (
    aEval.sizeBytes !==
    bEval.sizeBytes
  ) {
    return (
      aEval.sizeBytes -
      bEval.sizeBytes
    );
  }

  // 4. Numeric version ascending
  return (
    Number(a.version) -
    Number(b.version)
  );
}


// ============================================================
// MAIN PROMOTION FUNCTION
// ============================================================

function runPromotion(body) {

  // ----------------------------------------------------------
  // Required HTTP 400 validation
  // ----------------------------------------------------------

  if (!validateRequest(body)) {
    return {
      status: 400,
      body: {
        error: "INVALID_INPUT"
      }
    };
  }

  if (!validatePolicy(body.policy)) {
    return {
      status: 400,
      body: {
        error: "INVALID_INPUT"
      }
    };
  }


  const failedGates = {};


  // ----------------------------------------------------------
  // IMPORTANT:
  // Check duplicates BEFORE lookup map.
  // ----------------------------------------------------------

  const seenVersions = new Set();

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

    if (seenVersions.has(id)) {
      contractFailure = true;

      addFailure(
        failedGates,
        id,
        "DUPLICATE_VERSION"
      );
    }

    seenVersions.add(id);
  }


  // ----------------------------------------------------------
  // Contract failure = block
  // ----------------------------------------------------------

  if (contractFailure) {
    return {
      status: 200,
      body: {
        action: "block",
        championVersion:
          body.championVersion,
        selectedVersion: null,
        eligibleVersions: [],
        failedGates:
          finalizeFailedGates(
            failedGates
          ),
        aliasMutation: null,
        evidence: null
      }
    };
  }


  // ----------------------------------------------------------
  // NOW build lookup map
  // ----------------------------------------------------------

  const versionMap = new Map();

  for (const version of body.versions) {
    versionMap.set(
      version.version,
      version
    );
  }


  // ----------------------------------------------------------
  // Validate evidence
  // ----------------------------------------------------------

  const eligible = [];

  const asOfMs =
    Date.parse(body.asOf);

  for (const version of body.versions) {

    const shapeErrors =
      validateVersionShape(version);

    if (shapeErrors.length > 0) {

      const id =
        isObject(version)
          ? String(version.version)
          : "";

      for (const code of shapeErrors) {
        addFailure(
          failedGates,
          id,
          code
        );
      }

      continue;
    }

    const isEligible =
      checkEvidence(
        version,
        body.policy,
        asOfMs,
        failedGates
      );

    if (isEligible) {
      eligible.push(version);
    }
  }


  // ----------------------------------------------------------
  // Rank eligible models
  // ----------------------------------------------------------

  eligible.sort(compareEligible);

  const eligibleVersions =
    eligible.map(
      (version) => version.version
    );


  // ----------------------------------------------------------
  // Champion must exist
  // ----------------------------------------------------------

  const champion =
    versionMap.get(
      body.championVersion
    );

  if (!champion) {

    addFailure(
      failedGates,
      body.championVersion,
      "INVALID_VERSION"
    );

    return {
      status: 200,
      body: {
        action: "block",
        championVersion:
          body.championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates:
          finalizeFailedGates(
            failedGates
          ),
        aliasMutation: null,
        evidence: null
      }
    };
  }


  // ----------------------------------------------------------
  // Champion evidence must be valid
  // ----------------------------------------------------------

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
        failedGates:
          finalizeFailedGates(
            failedGates
          ),
        aliasMutation: null,
        evidence: null
      }
    };
  }


  // ----------------------------------------------------------
  // Find best challenger
  // ----------------------------------------------------------

  const challengers =
    eligible.filter(
      (version) =>
        version.version !==
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
        failedGates:
          finalizeFailedGates(
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

  const improvement =
    round12(
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
        failedGates:
          finalizeFailedGates(
            failedGates
          ),
        aliasMutation: null,
        evidence:
          champion.evaluation
      }
    };
  }


  // ----------------------------------------------------------
  // PROMOTE
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
      failedGates:
        finalizeFailedGates(
          failedGates
        ),
      aliasMutation: {
        alias: "champion",
        version:
          challenger.version
      },
      evidence:
        challenger.evaluation
    }
  };
}


// ============================================================
// VERCEL HANDLER
// ============================================================

module.exports = async function handler(
  req,
  res
) {

  res.setHeader(
    "Content-Type",
    "application/json"
  );


  // Only POST
  if (req.method !== "POST") {
    res.status(400).json({
      error: "INVALID_INPUT"
    });
    return;
  }


  try {

    let body = req.body;


    // --------------------------------------------------------
    // Vercel normally parses JSON.
    // But handle a raw string too.
    // --------------------------------------------------------

    if (typeof body === "string") {

      try {
        body = JSON.parse(body);
      } catch (parseError) {
        res.status(400).json({
          error: "INVALID_INPUT"
        });
        return;
      }
    }


    // --------------------------------------------------------
    // Run the actual gate
    // --------------------------------------------------------

    const result =
      runPromotion(body);


    res
      .status(result.status)
      .json(result.body);

  } catch (error) {

    // IMPORTANT:
    // Don't let an unexpected JavaScript exception
    // escape the Vercel function.
    //
    // Log it so we can diagnose it from Vercel logs.

    console.error(
      "PROMOTE_ERROR",
      error &&
        error.stack
        ? error.stack
        : error
    );

    res.status(500).json({
      error: "INTERNAL_ERROR"
    });
  }
};
