'use strict';

const express = require('express');
const request = require('superagent');
const CODE_CLIMATE_TOKEN = '???';

const app = express();

function asPromised(block) {
  return new Promise((y, n) => block((e, r) => e ? n(e) : y(r)));
}

function delay(ms) {
  return asPromised(cb => setTimeout(cb, ms));
}

function reportStatus(pull_request, state, description) {
  const repo_name = pull_request.head.repo.full_name;
  return asPromised(cb => {
    request.post(`https://api.github.com/repos/${repo_name}/statuses/${pull_request.head.sha}`).send({
      state: state,
      target_url: `https://codeclimate.com/github/${repo_name}`,
      description: description,
      context: 'codeclimate/coverage'
    });
  })
}

function reportError(pull_request, error) {
  return reportStatus(pull_request, 'error', error.toString());
}

function reportPending(pull_request) {
  return reportStatus(pull_request, 'pending', 'Coverage is being collected.');
}

function reportCoverage(pull_request, coverage_change) {
  if (coverage_change < 0) {
    return reportStatus(pull_request, 'failure', `Coverage decreased by ${-coverage_change}%`);
  } else if (coverage_change > 0) {
    return reportStatus(pull_request, 'success', `Coverage increased by ${coverage_change}%`);
  }
  return reportStatus(pull_request, 'success', 'Coverage is the same');
}

function getRepoId(repo_name) {
  return asPromised(cb => {
    request.get(`https://codeclimate.com/api/repos`).query({
      api_token: CODE_CLIMATE_TOKEN
    }).end(cb);
  }).then(response => response.data).then(repos => {
    return repos.find(repo => repo.url.includes(repo_name)).id;
  });
}

function getCoverage(branch) {
  const repo_name = branch.repo.full_name;
  const branch_name = branch.ref;

  return getRepoId(repo_name).then(repo_id => asPromised(cb => {
    request.get(`https://codeclimate.com/api/repos/${repo_id}/branches/${branch_name}`).query({
      api_token: CODE_CLIMATE_TOKEN
    }).end(cb);
  })).then(response => response.data.last_snapshot).then(snapshot => {
    if (snapshot.commit_sha !== branch.sha) return null;
    return snapshot.covered_percent;
  });
}

function pollForCoverage(pull_request) {
  const pull_request = req.data.pull_request;
  return Promise.all([
    getCoverage(pull_request.head, cb),
    getCoverage(pull_request.base, cb)
  ]).then(coverages => {
    const [head_coverage, base_coverage] = coverages;
    if (head_coverage === null || base_coverage === null) {
      return reportPending(pull_request).then(() => delay(1000)).then(() => pollForCoverage(pull_request));
    } else {
      return head_coverage - base_coverage;
    }
  })
  .then(coverage_change => reportCoverage(pull_request, coverage_change))
  .catch(error => reportError(pull_request, error));
}

function handlePullRequestEvent(data) {
  const action = data.action;
  if (action === 'opened' || action === 'synchronize') {
    const pull_request = data.pull_request;
    pollForCoverage(pull_request).catch(error => console.error(error));
  }
}

app.get('/webhook', (req, res) => {
  const event = req.get('X-Github-Event');
  if (event === 'pull_request') {
    handlePullRequestEvent(req.data);
  }
  res.send({ error: false, message: 'OK' });
});
