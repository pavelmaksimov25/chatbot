CLUSTER  := chatbot
NS       := chatbot
SERVICES := bff-gateway api user-service

.PHONY: cluster-up cluster-down secrets images load deploy undeploy verify jaeger prometheus grafana

cluster-up: ## Create the kind cluster (host 8443 → Caddy ingress)
	kind create cluster --config infra/kind/cluster.yaml

secrets: ## Create k8s secrets from the local gitignored .env
	./scripts/bootstrap-secrets.sh

cluster-down: ## Delete the kind cluster
	kind delete cluster --name $(CLUSTER)

images: ## Build a Docker image per service
	@for s in $(SERVICES); do \
		docker build -t chatbot/$$s:dev --build-arg SERVICE=$$s -f infra/docker/service.Dockerfile . || exit 1; \
	done

load: ## Load the service images into kind
	kind load docker-image $(SERVICES:%=chatbot/%:dev) --name $(CLUSTER)

deploy: ## Install/upgrade the Helm release and wait for rollout
	helm upgrade --install chatbot charts/chatbot --namespace $(NS) --create-namespace
	kubectl --namespace $(NS) wait --for=condition=available deployment --all --timeout=180s

undeploy: ## Uninstall the Helm release
	helm uninstall chatbot --namespace $(NS)

verify: ## Hit every service liveness + readiness endpoint through the Caddy ingress (HTTPS)
	@for s in $(SERVICES); do \
		curl -fsk https://localhost:8443/healthz/$$s || exit 1; echo; \
		curl -fsk https://localhost:8443/healthz/$$s/ready || exit 1; echo; \
	done

jaeger: ## Port-forward the Jaeger UI → http://localhost:16686
	kubectl --namespace $(NS) port-forward svc/chatbot-jaeger 16686:16686

prometheus: ## Port-forward Prometheus → http://localhost:9090
	kubectl --namespace $(NS) port-forward svc/chatbot-prometheus 9090:9090

grafana: ## Port-forward Grafana → http://localhost:3300 (admin/admin)
	kubectl --namespace $(NS) port-forward svc/chatbot-grafana 3300:3000
