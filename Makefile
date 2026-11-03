AWS_REGION ?= eu-west-1
STACK_NAME ?= FileSharing

.PHONY: install test synth diff deploy set-secrets outputs probe smoke pentest pentest-owner dev vendor

install:
	npm ci

test: vendor
	npm test -- --runInBand

synth: vendor
	AWS_REGION=$(AWS_REGION) npm run synth -- --quiet

diff: vendor
	AWS_REGION=$(AWS_REGION) npm run diff

# Copies PDF.js into web/vendor/pdfjs/ (git-ignored) for the PDF preview.
vendor:
	node scripts/vendor-pdfjs.js

# Deploys this stack and the Lambda@Edge companion stack in us-east-1.
deploy: test
	AWS_REGION=$(AWS_REGION) npm run deploy

# Prompts for the Microsoft Entra app's tenant ID, client ID and client secret and stores them in SSM.
set-secrets:
	AWS_REGION=$(AWS_REGION) scripts/set-secrets.sh

outputs:
	aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table

# Checks, from this computer, that SharePoint still answers the way the site expects (see "When SharePoint
# changes" in the README). Needs a test link: SHARE_PROBE_LINK=... or config/probe.local.json.
probe:
	node scripts/probe.js

# End-to-end test against the deployed site: creates a throwaway link to the test share, opens it and deletes it.
smoke:
	AWS_REGION=$(AWS_REGION) node scripts/smoke-test.js

# Live penetration tests (see the README). pentest-owner also signs a short owner session and makes throwaway links.
pentest:
	node scripts/pentest.js

pentest-owner:
	AWS_REGION=$(AWS_REGION) node scripts/pentest.js --owner

# Local preview that runs the real viewer function, API and edge code (no AWS). See scripts/dev-server.js.
dev: vendor
	node scripts/dev-server.js
