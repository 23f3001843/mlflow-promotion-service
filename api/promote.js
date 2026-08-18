const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function object(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function timestamp(x) {
  return (
    typeof x === "string" &&
    TIMESTAMP_RE.test(x) &&
    Number.isFinite(Date.parse(x))
  );
}

function finite(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function unit(x) {
  return finite(x) && x >= 0 && x <= 1;
}

function safeInt(x) {
  return (
    typeof x === "number" &&
    Number.isSafeInteger(x) &&
    x >= 0
  );
}

function version(x) {
  if (typeof x !== "string") return false;
  if (!/^[1-9][0-9]*$/.test(x)) return false;

  const n = Number(x);

  return (
    Number.isSafeInteger(n) &&
    n > 0 &&
    String(n) === x
  );
}

function sortCodes(a, b) {
  return Buffer.compare(
    Buffer.from(a, "utf8"),
    Buffer.from(b, "utf8")
  );
}

function finishFailures(failures) {
  const output = {};

  Object.keys(failures)
    .sort(sortCodes)
    .forEach((id) => {
      output[id] = [
        ...new Set(failures[id])
      ].sort(sortCodes);
    });

  return output;
}

function fail(failures, id, code) {
  const key = String(id);

  if (!failures[key]) {
    failures[key] = [];
  }

  failures[key].push(code);
}

function round12(x) {
  return Math.round(x * 1000000000000) / 1000000000000;
}


// ============================================================
// POLICY
// ============================================================

function validPolicy(p) {
  if (!object(p)) return false;

  if (
    typeof p.datasetDigest !== "string" ||
    p.datasetDigest.length === 0
  ) {
    return false;
  }

  if (
    typeof p.schemaDigest !== "string" ||
    p.schemaDigest.length === 0
  ) {
    return false;
  }

  if (!safeInt(p.maxAgeSeconds)) {
    return false;
  }

  if (!unit(p.accuracyFloor)) {
    return false;
  }

  if (!object(p.requiredSlices)) {
    return false;
  }

  for (const name of Object.keys(p.requiredSlices)) {
    if (!unit(p.requiredSlices[name])) {
      return false;
    }
  }

  if (
    !finite(p.maxLatencyMs) ||
    p.maxLatencyMs < 0
  ) {
    return false;
  }

  if (!safeInt(p.maxSizeBytes)) {
    return false;
  }

  if (!unit(p.minImprovement)) {
    return false;
  }

  return true;
}


// ============================================================
// EVIDENCE
// ============================================================

function checkVersion(v, policy, asOf, failures) {
  const id = v.version;
  const e = v.evaluation;

  if (!object(e)) {
    fail(failures, id, "MISSING_EVALUATION");
    return false;
  }

  let good = true;

  // Timestamp
  if (!timestamp(e.createdAt)) {
    fail(failures, id, "INVALID_TIMESTAMP");
    good = false;
  } else {
    const created = Date.parse(e.createdAt);

    if (created > asOf) {
      fail(failures, id, "FUTURE_EVALUATION");
      good = false;
    }

    if (
      created <
      asOf - policy.maxAgeSeconds * 1000
    ) {
      fail(failures, id, "STALE_EVALUATION");
      good = false;
    }
  }

  // Numeric values
  if (
    !finite(e.accuracy) ||
    !finite(e.latencyMs) ||
    !finite(e.sizeBytes)
  ) {
    fail(failures, id, "NON_FINITE");
    good = false;
  }

  // Accuracy range
  if (
    finite(e.accuracy) &&
    (e.accuracy < 0 || e.accuracy > 1)
  ) {
    fail(failures, id, "METRIC_RANGE");
    good = false;
  }

  // Artifact
  if (e.artifactDigest !== v.artifactDigest) {
    fail(failures, id, "ARTIFACT_MISMATCH");
    good = false;
  }

  // Dataset
  if (e.datasetDigest !== policy.datasetDigest) {
    fail(failures, id, "DATASET_MISMATCH");
    good = false;
  }

  // Schema
  if (e.schemaDigest !== policy.schemaDigest) {
    fail(failures, id, "SCHEMA_MISMATCH");
    good = false;
  }

  // Accuracy floor
  if (
    !finite(e.accuracy) ||
    e.accuracy < policy.accuracyFloor
  ) {
    fail(failures, id, "ACCURACY_FLOOR");
    good = false;
  }

  // Latency
  if (
    !finite(e.latencyMs) ||
    e.latencyMs < 0 ||
    e.latencyMs > policy.maxLatencyMs
  ) {
    fail(failures, id, "LATENCY_LIMIT");
    good = false;
  }

  // Size
  if (
    !safeInt(e.sizeBytes) ||
    e.sizeBytes > policy.maxSizeBytes
  ) {
    fail(failures, id, "SIZE_LIMIT");
    good = false;
  }

  // Slices
  if (!object(e.slices)) {
    for (const name of Object.keys(policy.requiredSlices)) {
      fail(
        failures,
        id,
        `MISSING_SLICE:${name}`
      );
    }

    good = false;
  } else {
    for (const name of Object.keys(policy.requiredSlices)) {
      if (
        !Object.prototype.hasOwnProperty.call(
          e.slices,
          name
        )
      ) {
        fail(
          failures,
          id,
          `MISSING_SLICE:${name}`
        );

        good = false;
        continue;
      }

      const value = e.slices[name];

      if (!unit(value)) {
        fail(
          failures,
          id,
          `SLICE_RANGE:${name}`
        );

        good = false;
        continue;
      }

      if (
        value <
        policy.requiredSlices[name]
      ) {
        fail(
          failures,
          id,
          `SLICE_FLOOR:${name}`
        );

        good = false;
      }
    }
  }

  return good;
}


// ============================================================
// MAIN
// ============================================================

function processPromotion(body) {
  // Request validation
  if (!object(body)) {
    return {
      status: 400,
      result: { error: "INVALID_INPUT" }
    };
  }

  if (!timestamp(body.asOf)) {
    return {
      status: 400,
      result: { error: "INVALID_INPUT" }
    };
  }

  if (!version(body.championVersion)) {
    return {
      status: 400,
      result: { error: "INVALID_INPUT" }
    };
  }

  if (!validPolicy(body.policy)) {
    return {
      status: 400,
      result: { error: "INVALID_INPUT" }
    };
  }

  if (!Array.isArray(body.versions)) {
    return {
      status: 400,
      result: { error: "INVALID_INPUT" }
    };
  }

  const failures = {};
  const seen = new Set();

  // ----------------------------------------------------------
  // Duplicate / invalid version check FIRST
  // ----------------------------------------------------------

  for (const v of body.versions) {
    if (!object(v)) {
      fail(failures, "", "INVALID_VERSION");
      continue;
    }

    if (!version(v.version)) {
      fail(
        failures,
        v.version,
        "INVALID_VERSION"
      );
      continue;
    }

    if (seen.has(v.version)) {
      fail(
        failures,
        v.version,
        "DUPLICATE_VERSION"
      );
    }

    seen.add(v.version);
  }

  // Contract failure
  for (const id of Object.keys(failures)) {
    if (
      failures[id].includes("INVALID_VERSION") ||
      failures[id].includes("DUPLICATE_VERSION")
    ) {
      return {
        status: 200,
        result: {
          action: "block",
          championVersion:
            body.championVersion,
          selectedVersion: null,
          eligibleVersions: [],
          failedGates:
            finishFailures(failures),
          aliasMutation: null,
          evidence: null
        }
      };
    }
  }

  // ----------------------------------------------------------
  // Lookup
  // ----------------------------------------------------------

  const lookup = {};

  for (const v of body.versions) {
    lookup[v.version] = v;
  }

  // ----------------------------------------------------------
  // Evaluate all versions
  // ----------------------------------------------------------

  const eligible = [];
  const asOf = Date.parse(body.asOf);

  for (const v of body.versions) {
    if (!object(v)) continue;

    if (
      typeof v.artifactDigest !== "string" ||
      v.artifactDigest.length === 0
    ) {
      fail(
        failures,
        v.version,
        "INVALID_VERSION"
      );
      continue;
    }

    if (!object(v.evaluation)) {
      fail(
        failures,
        v.version,
        "MISSING_EVALUATION"
      );
      continue;
    }

    if (
      checkVersion(
        v,
        body.policy,
        asOf,
        failures
      )
    ) {
      eligible.push(v);
    }
  }

  // ----------------------------------------------------------
  // Ranking
  // ----------------------------------------------------------

  eligible.sort((a, b) => {
    if (
      a.evaluation.accuracy !==
      b.evaluation.accuracy
    ) {
      return (
        b.evaluation.accuracy -
        a.evaluation.accuracy
      );
    }

    if (
      a.evaluation.latencyMs !==
      b.evaluation.latencyMs
    ) {
      return (
        a.evaluation.latencyMs -
        b.evaluation.latencyMs
      );
    }

    if (
      a.evaluation.sizeBytes !==
      b.evaluation.sizeBytes
    ) {
      return (
        a.evaluation.sizeBytes -
        b.evaluation.sizeBytes
      );
    }

    return (
      Number(a.version) -
      Number(b.version)
    );
  });

  const eligibleVersions =
    eligible.map((v) => v.version);

  // ----------------------------------------------------------
  // Champion
  // ----------------------------------------------------------

  const champion =
    lookup[body.championVersion];

  if (!champion) {
    fail(
      failures,
      body.championVersion,
      "INVALID_VERSION"
    );

    return {
      status: 200,
      result: {
        action: "block",
        championVersion:
          body.championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates:
          finishFailures(failures),
        aliasMutation: null,
        evidence: null
      }
    };
  }

  // Champion has any failed gate
  const championFailures =
    failures[body.championVersion] || [];

  if (championFailures.length > 0) {
    return {
      status: 200,
      result: {
        action: "block",
        championVersion:
          body.championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates:
          finishFailures(failures),
        aliasMutation: null,
        evidence: null
      }
    };
  }

  // ----------------------------------------------------------
  // Challenger
  // ----------------------------------------------------------

  const challengers = eligible.filter(
    (v) =>
      v.version !==
      body.championVersion
  );

  // Nothing better to consider
  if (challengers.length === 0) {
    return {
      status: 200,
      result: {
        action: "retain",
        championVersion:
          body.championVersion,
        selectedVersion:
          body.championVersion,
        eligibleVersions,
        failedGates:
          finishFailures(failures),
        aliasMutation: null,
        evidence:
          champion.evaluation
      }
    };
  }

  const challenger = challengers[0];

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
      result: {
        action: "retain",
        championVersion:
          body.championVersion,
        selectedVersion:
          body.championVersion,
        eligibleVersions,
        failedGates:
          finishFailures(failures),
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
    result: {
      action: "promote",
      championVersion:
        body.championVersion,
      selectedVersion:
        challenger.version,
      eligibleVersions,
      failedGates:
        finishFailures(failures),
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
// VERCEL
// ============================================================

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

  // Sometimes body can arrive as a string.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      res.status(400).json({
        error: "INVALID_INPUT"
      });
      return;
    }
  }

  // IMPORTANT:
  // No catch block hiding the actual result.
  //
  // If something genuinely crashes, Vercel will now show
  // the actual stack trace in the function logs.
  const output = processPromotion(body);

  res
    .status(output.status)
    .json(output.result);
};
