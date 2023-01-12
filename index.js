const core = require('@actions/core');
const github = require('@actions/github');

const pulls = await github.paginate('GET /repos/:owner/:repo/pulls', {
    owner: context.repo.owner,
    repo: context.repo.repo
  });
  const semverRegex = /(?<=^v?|\sv?)(?:(?:0|[1-9]\d{0,9}?)\.){2}(?:0|[1-9]\d{0,9})(?:-(?:--+)?(?:0|[1-9]\d*|\d*[a-z]+\d*)){0,100}(?=$| |\+|\.)(?:(?<=-\S+)(?:\.(?:--?|[\da-z-]*[a-z-]\d*|0|[1-9]\d*)){1,100}?)?(?!\.)(?:\+(?:[\da-z]\.?-?){1,100}?(?!\w))?(?!\+)/gi
  let branchesAndPRStrings = [];
  let baseBranch = null;
  let baseBranchSHA = null;
  for (const pull of pulls) {
    const branch = pull['head']['ref'];
    const author = pull['user']['login'];
    const title = pull['title'];
    let updateType = null;
    
    if (author == 'dependabot[bot]') {
      versions = title.match(semverRegex);
      lastVersion = versions[0];
      nextVersion = versions[1];
      if (lastVersion && nextVersion && (lastVersion !== nextVersion)) {
        const lastParts = lastVersion.split('.')
        const nextParts = nextVersion.split('.')
        if (lastParts[0] !== nextParts[0]) {
          updateType = 'major';
        } else if (lastParts.length < 2 || nextParts.length < 2 || lastParts[1] !== nextParts[1]) {
          updateType = 'minor';
        } else {
          updateType = 'patch';
        }
      }
      console.log('Branch opened by dependabot: ' + branch);
      let statusOK = true;
      if (updateType === 'major') {
        statusOK = false;
        console.log('Not combining major version update from branch: ' + branch);
      }
      console.log('Checking green status: ' + branch);
      const stateQuery = `query($owner: String!, $repo: String!, $pull_number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number:$pull_number) {
            mergeable
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                  }
                }
              }
            }
          }
        }
      }`
      const vars = {
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pull['number']
      };
      const result = await github.graphql(stateQuery, vars);
      const [{ commit }] = result.repository.pullRequest.commits.nodes;
      if(commit.statusCheckRollup != null){
        const state = commit.statusCheckRollup.state
        console.log('Validating status: ' + state);
        if(state != 'SUCCESS') {
          console.log('Discarding ' + branch + ' with status ' + state);
          statusOK = false;
        }
      } else {
        const mergeable = result.repository.pullRequest.mergeable
        console.log('PR does not have statusCheckRollup, but mergeability is: ' + mergeable);
        if(mergeable !== 'MERGEABLE'){
          console.log('Discarding ' + branch + ' with mergeability: ' + mergeable);
          statusOK = false;
        }
      }
      if (statusOK) {
        console.log('Adding branch to array: ' + branch);
        const prString = '#' + pull['number'] + ' ' + pull['title'];
        const prBody = pull['body'].split("[![Dependabot compatibility score]")[0] + "---";
        branchesAndPRStrings.push({ branch, prString, prBody });
        baseBranch = pull['base']['ref'];
        baseBranchSHA = pull['base']['sha'];
      }
    }
  }
  if (branchesAndPRStrings.length < 2) {
    core.setFailed('No PRs/branches matched criteria');
    return;
  }
  try {
    await github.rest.git.createRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: 'refs/heads/combined-dependabot-prs',
      sha: baseBranchSHA,
    });
  } catch (error) {
    console.log('Failed to create combined branch - maybe a branch by that name already exists?');
    try {
      console.log('Trying to push to existing combined branch');
      await github.rest.git.updateRef({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: 'heads/combined-dependabot-prs',
        sha: baseBranchSHA,
        force: true
      });
    } catch (error) {
      console.log(error);
      core.setFailed('Failed to update combined branch');
      return;
    }
  }
  
  let combinedPRs = [];
  let PRbodies = [];
  let mergeFailedPRs = [];
  for(const { branch, prString, prBody } of branchesAndPRStrings) {
    try {
      await github.rest.repos.merge({
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: 'combined-dependabot-prs',
        head: branch,
      });
      console.log('Merged branch ' + branch);
      combinedPRs.push(prString);
      PRbodies.push(prBody);
    } catch (error) {
      console.log('Failed to merge branch ' + branch);
      mergeFailedPRs.push(prString);
    }
  }
  
  console.log('Creating combined PR');
  combined = combinedPRs.reduce(function(arr, v, i) { return arr.concat(v, PRbodies[i])}, []);
  combinedPRsString = combined.join('\n');
  let body = '### ✅ This PR was created by the Combine PRs action by combining the following PRs:\n' + combinedPRsString;
  if(mergeFailedPRs.length > 0) {
    const mergeFailedPRsString = mergeFailedPRs.join('\n');
    body += '\n\n⚠️ The following PRs were left out due to merge conflicts:\n' + mergeFailedPRsString
  }
  
  date = new Date().toUTCString();
  try {
    await github.rest.pulls.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: 'Combined PR - ' + date,
      head: 'combined-dependabot-prs',
      base: baseBranch,
      body: body
    });
  } catch (error) {
    console.log('Failed to create pull request: Maybe a pull request already exists for this branch?');
    try {
      const prslist = await github.rest.pulls.list({
        owner: context.repo.owner,
        repo: context.repo.repo,
        state: 'open'
      });
      console.log('Trying to update existing pull request');
      for (const pr of prslist.data){
        if (pr.head.ref == 'combined-dependabot-prs') {
          await github.rest.pulls.update({
            owner: context.repo.owner,
            repo: context.repo.repo,
            title: 'Combined PR - ' + date,
            head: 'combined-dependabot-prs',
            base: baseBranch,
            body: body,
            pull_number: pr.number
          });
        }
      }
    } catch (error) {
      console.log(error);
      core.setFailed('Failed to update pull request');
      return;
    }
  }