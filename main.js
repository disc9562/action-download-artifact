const core = require('@actions/core')
const github = require('@actions/github')
const AdmZip = require('adm-zip')
const filesize = require('filesize')
const pathname = require('path')
const retry = require('async-retry')
const fs = require('fs')
import {bail} from 'bail'

async function main() {
    try {
        const token = core.getInput("github_token", { required: true })
        const workflow = core.getInput("workflow", { required: true })
        const [owner, repo] = core.getInput("repo", { required: true }).split("/")
        const path = core.getInput("path", { required: true })
        const name = core.getInput("name")
        let workflowConclusion = core.getInput("workflow_conclusion")
        let pr = core.getInput("pr")
        let commit = core.getInput("commit")
        let branch = core.getInput("branch")
        let event = core.getInput("event")
        let runID = core.getInput("run_id")
        let runNumber = core.getInput("run_number")
        let checkArtifacts = core.getInput("check_artifacts")

        const client = github.getOctokit(token)

        console.log("==> Workflow:", workflow)

        console.log("==> Repo:", owner + "/" + repo)

        console.log("==> Conclusion:", workflowConclusion)

        if (pr) {
            console.log("==> PR:", pr)

            const pull = await client.pulls.get({
                owner: owner,
                repo: repo,
                pull_number: pr,
            })
            commit = pull.data.head.sha
        }

        if (commit) {
            console.log("==> Commit:", commit)
        }

        if (branch) {
            branch = branch.replace(/^refs\/heads\//, "")
            console.log("==> Branch:", branch)
        }

        if (event) {
            console.log("==> Event:", event)
        }

        if (runNumber) {
            console.log("==> RunNumber:", runNumber)
        }

        if (!runID) {
            for await (const runs of client.paginate.iterator(client.actions.listWorkflowRuns, {
                owner: owner,
                repo: repo,
                workflow_id: workflow,
                branch: branch,
                event: event,
            }
            )) {
                for (const run of runs.data) {
                    if (commit && run.head_sha != commit) {
                        continue
                    }
                    if (runNumber && run.run_number != runNumber) {
                        continue
                    }
                    if (workflowConclusion && (workflowConclusion != run.conclusion && workflowConclusion != run.status)) {
                        continue
                    }
                    if (checkArtifacts) {
                        let artifacts = await client.actions.listWorkflowRunArtifacts({
                            owner: owner,
                            repo: repo,
                            run_id: run.id,
                        })
                        if (artifacts.data.artifacts.length == 0) {
                            continue
                        }
                    }
                    runID = run.id
                    break
                }
                if (runID) {
                    break
                }
            }
        }

        if (runID) {
            console.log("==> RunID:", runID)
        } else {
            throw new Error("no matching workflow run found")
        }

        // let artifacts

        await retry(
            async (bail) => {
              // if anything throws, we retry
              let artifacts = await retry(async () => {
                return client.paginate(client.actions.listWorkflowRunArtifacts, {
                      owner: owner,
                      repo: repo,
                      run_id: runID,
                  })
              }, null, {retriesMax: 10, interval: 100, exponential: true, factor: 3, jitter: 100})

              console.log(artifacts) // output : OK

              // One artifact or all if `name` input is not specified.
              if (name) {
                  artifacts = artifacts.filter((artifact) => {
                      return artifact.name == name
                  })
              }

              if (artifacts.length == 0)
                bail(new Error("no artifacts found"))

            for (const artifact of artifacts) {
                console.log("==> Artifact:", artifact.id)

                const size = filesize(artifact.size_in_bytes, { base: 10 })

                console.log(`==> Downloading: ${artifact.name}.zip (${size})`)

                let zip = await client.actions.downloadArtifact({
                            owner: owner,
                            repo: repo,
                            artifact_id: artifact.id,
                            archive_format: "zip",
                        })

                const dir = name ? path : pathname.join(path, artifact.name)

                fs.mkdirSync(dir, { recursive: true })

                const adm = new AdmZip(Buffer.from(zip.data))

                adm.getEntries().forEach((entry) => {
                    const action = entry.isDirectory ? "creating" : "inflating"
                    const filepath = pathname.join(dir, entry.entryName)

                    console.log(`  ${action}: ${filepath}`)
                })

                adm.extractAllTo(dir, true)
                }
            },
            {
              retries: 5,
            }
          );
    } catch (error) {
        core.setFailed(error.message)
    }
}

main()
