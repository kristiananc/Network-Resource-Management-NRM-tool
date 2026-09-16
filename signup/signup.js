(function () {
  "use strict";

  const RESPONSE_TIMEOUT_MS = 15000;
  const form = document.getElementById("access-request-form");
  const consent = document.getElementById("consent");
  const submissionIdField = document.getElementById("submission-id");
  const submitButton = document.getElementById("submit-button");
  const status = document.getElementById("submission-status");
  let submissionPending = false;
  let pendingSubmissionId = "";
  let responseTimeoutId = null;

  function endpoint() {
    return String(window.NRM_ACCESS_REQUEST_ENDPOINT || "").trim();
  }

  function updateSubmitState() {
    submitButton.disabled = !consent.checked || submissionPending;
  }

  function showStatus(message, className) {
    status.textContent = message;
    status.className = className || "";
  }

  function newSubmissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "submission-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  function isTrustedResponseOrigin(origin) {
    try {
      const url = new URL(origin);
      const hostname = url.hostname.toLowerCase();
      return url.protocol === "https:" && (
        hostname === "script.google.com" ||
        hostname === "script.googleusercontent.com" ||
        /^[a-z0-9-]+-script\.googleusercontent\.com$/.test(hostname)
      );
    } catch (error) {
      return false;
    }
  }

  function clearResponseTimeout() {
    if (responseTimeoutId !== null) {
      window.clearTimeout(responseTimeoutId);
      responseTimeoutId = null;
    }
  }

  function finishSubmission(message, className, resetForm) {
    clearResponseTimeout();
    submissionPending = false;
    pendingSubmissionId = "";
    if (resetForm) form.reset();
    submissionIdField.value = "";
    showStatus(message, className);
    updateSubmitState();
  }

  consent.addEventListener("change", updateSubmitState);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!form.reportValidity() || !consent.checked) {
      updateSubmitState();
      return;
    }

    const targetEndpoint = endpoint();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(targetEndpoint)) {
      showStatus("This signup form is not configured yet. Please contact support.", "error");
      return;
    }

    pendingSubmissionId = newSubmissionId();
    submissionIdField.value = pendingSubmissionId;
    submissionPending = true;
    updateSubmitState();
    showStatus("Submitting your request…", "");
    form.action = targetEndpoint;
    clearResponseTimeout();
    responseTimeoutId = window.setTimeout(function () {
      if (!submissionPending) return;
      finishSubmission(
        "We could not confirm your request. Please check back or try again.",
        "error",
        false
      );
    }, RESPONSE_TIMEOUT_MS);
    HTMLFormElement.prototype.submit.call(form);
  });

  window.addEventListener("message", function (event) {
    const data = event.data;
    if (!submissionPending || !isTrustedResponseOrigin(event.origin)) return;
    if (!data || data.source !== "nrm-access-request") return;
    if (data.submission_id !== pendingSubmissionId) return;

    if (data.ok === true) {
      finishSubmission(data.message || "Access request received.", "success", true);
    } else {
      finishSubmission(
        data.message || "The request could not be submitted.",
        "error",
        false
      );
    }
  });

  updateSubmitState();
}());
