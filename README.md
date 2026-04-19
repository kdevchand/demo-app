# AKS Ecommerce – Complete Deployment Guide

This guide covers everything needed to deploy the ecommerce microservices application on **Azure Kubernetes Service (AKS)** using Terraform for infrastructure and GitHub Actions for CI/CD.

---

## Architecture Overview

```
  Developer / Browser
         │
         ▼
  ┌─────────────────────────────────────────────────────────┐
  │              Azure Load Balancer (Public IP)            │
  └──────────────────────────┬──────────────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────┐
  │         NGINX Ingress Controller (ingress-nginx)        │
  │    Routes: /             → api-gateway:3000             │
  │            /api/orders   → order-service:3001           │
  │            /api/products → product-service:3002         │
  │            /api/users    → user-service:3003            │
  └────┬──────────┬───────────┬──────────────┬─────────────┘
       │          │           │              │
       ▼          ▼           ▼              ▼
  ┌─────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐
  │   API   │ │ Order  │ │ Product │ │  User    │
  │ Gateway │ │Service │ │ Service │ │ Service  │
  │ :3000   │ │ :3001  │ │  :3002  │ │  :3003   │
  └────┬────┘ └───┬────┘ └────┬────┘ └────┬─────┘
       │          │           │            │
       └──────────┴───────────┴────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────┐
  │       Azure Container Registry (ACR) – Image Pull       │
  │   api-gateway | order-service | product-service |       │
  │   user-service                                          │
  └─────────────────────────────────────────────────────────┘

  Infrastructure (Terraform):
  ┌─────────────────────────────────────────────────────────┐
  │  Resource Group → VNet/Subnet → AKS Cluster             │
  │  AKS Kubelet Identity ─── AcrPull Role ──► ACR          │
  │  Azure Storage Account (Terraform State Backend)        │
  └─────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```
aks/
├── terraform/                    ← Terraform root module
│   ├── providers.tf
│   ├── backend.tf
│   ├── variables.tf
│   ├── terraform.tfvars
│   ├── main.tf
│   ├── outputs.tf
│   └── modules/
│       ├── resource-group/       ← Azure Resource Group
│       ├── vnet/                 ← Virtual Network + Subnet
│       ├── aks/                  ← AKS Cluster
│       └── acr/                  ← ACR Pull Role Assignment
└── k8s/                          ← Kubernetes manifests
    ├── namespace.yaml
    ├── configmap.yaml
    ├── secret-acr.yaml           ← Template only, not applied directly
    ├── deployments/              ← One Deployment per service
    ├── services/                 ← One Service per service
    ├── ingress/                  ← NGINX Ingress routing rules
    └── hpa/                      ← Horizontal Pod Autoscalers

.github/workflows/
├── 01-terraform-aks.yml          ← Provision AKS cluster
└── 02-deploy-app.yml             ← Deploy application
```

---

## Prerequisites

Ensure you have the following installed on your local machine (only needed for manual steps — CI/CD uses GitHub-hosted runners):

| Tool | Version | Install |
|------|---------|---------|
| Azure CLI | >= 2.55 | https://learn.microsoft.com/en-us/cli/azure/install-azure-cli |
| Terraform | >= 1.5.0 | https://developer.hashicorp.com/terraform/install |
| kubectl | >= 1.29 | https://kubernetes.io/docs/tasks/tools/ |
| Helm | >= 3.12 | https://helm.sh/docs/intro/install/ |

You also need:
- An **Azure Subscription** with Owner or Contributor permissions
- An **Azure Container Registry (ACR)** with the 4 images already pushed:
  - `api-gateway:latest`
  - `order-service:latest`
  - `product-service:latest`
  - `user-service:latest`

---

## Pre-Step 1: Login to Azure

```bash
az login
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"
az account show   # Verify the correct subscription is active
```

---

## Pre-Step 2: Create an Azure Service Principal

This Service Principal is used by GitHub Actions to authenticate with Azure.

```bash
# Replace <YOUR_SUBSCRIPTION_ID> with your actual subscription ID
az ad sp create-for-rbac \
  --name "sp-aks-ecommerce-github" \
  --role "Contributor" \
  --scopes "/subscriptions/<YOUR_SUBSCRIPTION_ID>" \
  --sdk-auth
```

> **Save the output.** It looks like this:
> ```json
> {
>   "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
>   "clientSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
>   "subscriptionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
>   "tenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
> }
> ```

You will use these 4 values as GitHub Secrets in Pre-Step 5.

> **Note:** The Service Principal needs `Contributor` on your subscription plus `User Access Administrator` (or `Owner`) to create role assignments. To grant the extra permission:
> ```bash
> az role assignment create \
>   --assignee "<SP_CLIENT_ID>" \
>   --role "User Access Administrator" \
>   --scope "/subscriptions/<YOUR_SUBSCRIPTION_ID>"
> ```

---

## Pre-Step 3: Create the Terraform State Backend (Azure Storage)

Terraform stores its state in Azure Blob Storage. Run these commands **once** before the first workflow run.

> Replace `<STORAGE_ACCOUNT_NAME>` with a **globally unique** name (3–24 lowercase letters/numbers, no dashes).

```bash
# 1. Create resource group for Terraform state
az group create \
  --name rg-terraform-state \
  --location eastus

# 2. Create storage account
az storage account create \
  --name <STORAGE_ACCOUNT_NAME> \
  --resource-group rg-terraform-state \
  --location eastus \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access false

# 3. Create container
az storage container create \
  --name tfstate \
  --account-name <STORAGE_ACCOUNT_NAME>

# 4. Verify
az storage container list --account-name <STORAGE_ACCOUNT_NAME> --output table
```

Note down:
- Resource group: `rg-terraform-state`
- Storage account name: `<STORAGE_ACCOUNT_NAME>`
- Container name: `tfstate`

---

## Pre-Step 4: Get ACR Credentials

The deploy workflow creates an image pull secret in Kubernetes. You need ACR credentials for this.

**Option A – Enable ACR Admin User (easiest):**

```bash
# Enable admin user on ACR
az acr update --name <YOUR_ACR_NAME> --admin-enabled true

# Get credentials
az acr credential show --name <YOUR_ACR_NAME>
# Note the username (same as ACR name) and one of the passwords
```

**Option B – Use the Service Principal:**

Grant your Service Principal AcrPull on the ACR:
```bash
ACR_ID=$(az acr show --name <YOUR_ACR_NAME> --resource-group <ACR_RG> --query id --output tsv)
az role assignment create \
  --assignee "<SP_CLIENT_ID>" \
  --role "AcrPull" \
  --scope "$ACR_ID"
```
Then use `<SP_CLIENT_ID>` as `ACR_USERNAME` and `<SP_CLIENT_SECRET>` as `ACR_PASSWORD`.

---

## Pre-Step 5: Update terraform.tfvars

Open `aks/terraform/terraform.tfvars` and fill in your actual values:

```hcl
acr_name           = "myacrname"          # Your ACR name (without .azurecr.io)
acr_resource_group = "rg-my-acr"          # Resource group where ACR lives
```

All other values are pre-configured with sensible defaults. Change `location`, `cluster_name`, or VM sizes if needed.

---

## Pre-Step 6: Set GitHub Repository Secrets

Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add **all 13 secrets** listed below:

| Secret Name | Value | Where to get it |
|---|---|---|
| `AZURE_CLIENT_ID` | SP client ID | Output of `az ad sp create-for-rbac` |
| `AZURE_CLIENT_SECRET` | SP client secret | Output of `az ad sp create-for-rbac` |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID | Output of `az ad sp create-for-rbac` |
| `AZURE_TENANT_ID` | Azure tenant ID | Output of `az ad sp create-for-rbac` |
| `TF_BACKEND_RESOURCE_GROUP` | `rg-terraform-state` | Pre-Step 3 |
| `TF_BACKEND_STORAGE_ACCOUNT` | `<STORAGE_ACCOUNT_NAME>` | Pre-Step 3 |
| `TF_BACKEND_CONTAINER` | `tfstate` | Pre-Step 3 |
| `ACR_NAME` | `<YOUR_ACR_NAME>` | Your existing ACR name |
| `ACR_RESOURCE_GROUP` | `<ACR_RESOURCE_GROUP>` | Resource group of your ACR |
| `ACR_USERNAME` | ACR admin username or SP Client ID | Pre-Step 4 |
| `ACR_PASSWORD` | ACR admin password or SP Client Secret | Pre-Step 4 |
| `AKS_RESOURCE_GROUP` | `rg-aks-ecommerce-dev` | Matches `resource_group_name` in tfvars |
| `AKS_CLUSTER_NAME` | `aks-ecommerce-dev` | Matches `cluster_name` in tfvars |

> **Tip:** To set secrets quickly via CLI:
> ```bash
> gh secret set AZURE_CLIENT_ID --body "your-client-id"
> gh secret set AZURE_CLIENT_SECRET --body "your-client-secret"
> # ... repeat for all secrets
> ```

---

## Workflow 1: Deploy AKS Infrastructure

This workflow provisions the Azure infrastructure using Terraform.

**Run order:**
1. First run with `plan` to preview changes
2. Then run with `apply` to create resources (takes ~10–15 minutes)

**Steps:**
1. Go to your GitHub repository
2. Click **Actions** tab
3. Select **01 - Deploy AKS Infrastructure (Terraform)**
4. Click **Run workflow**
5. Select action: `plan` → Click **Run workflow**
6. Review the plan output in the logs
7. If the plan looks correct, run again with action: `apply`

**What gets created:**
- Azure Resource Group: `rg-aks-ecommerce-dev`
- Virtual Network + Subnet
- AKS Cluster: `aks-ecommerce-dev` (2 nodes, Standard_D2s_v3)
- AcrPull role assignment: AKS kubelet identity → your ACR

**Expected output after apply:**
```
AKS Cluster Name  : aks-ecommerce-dev
Resource Group    : rg-aks-ecommerce-dev
Cluster FQDN      : aks-ecommerce-dev-xxxx.hcp.eastus.azmk8s.io
ACR Login Server  : youracr.azurecr.io
Configure kubectl : az aks get-credentials --resource-group rg-aks-ecommerce-dev --name aks-ecommerce-dev --overwrite-existing
```

---

## Workflow 2: Deploy Application

This workflow deploys all Kubernetes manifests to the AKS cluster.

> **Prerequisite:** Workflow 1 (apply) must have completed successfully before running this.

**Steps:**
1. Go to **Actions** tab
2. Select **02 - Deploy Application to AKS**
3. Click **Run workflow**
4. Select action: `deploy` → Click **Run workflow**

**What gets deployed:**
1. NGINX Ingress Controller (via Helm)
2. `ecommerce` namespace
3. ACR image pull secret
4. ConfigMap with service URLs
5. Deployments for all 4 services (with your ACR images)
6. ClusterIP Services for all 4 services
7. Ingress with path-based routing
8. Horizontal Pod Autoscalers

---

## Accessing the Application in the Browser

After Workflow 2 completes successfully:

**Step 1 – Get the external IP:**
```bash
az aks get-credentials \
  --resource-group rg-aks-ecommerce-dev \
  --name aks-ecommerce-dev \
  --overwrite-existing

kubectl get service ingress-nginx-controller -n ingress-nginx
```

Look for the `EXTERNAL-IP` column. Wait 1–2 minutes if it shows `<pending>`.

Example output:
```
NAME                       TYPE           CLUSTER-IP    EXTERNAL-IP     PORT(S)
ingress-nginx-controller   LoadBalancer   10.0.12.34    20.55.100.200   80:32080/TCP,443:32443/TCP
```

**Step 2 – Access the application:**

| URL | Routes to |
|-----|-----------|
| `http://20.55.100.200/` | API Gateway (all traffic) |
| `http://20.55.100.200/api/orders` | Order Service |
| `http://20.55.100.200/api/products` | Product Service |
| `http://20.55.100.200/api/users` | User Service |

**Step 3 (Optional) – Use a custom domain:**

If you have a domain, create an A record pointing to the `EXTERNAL-IP`, then update `aks/k8s/ingress/ingress.yaml`:
```yaml
rules:
  - host: yourdomain.com   # Replace ecommerce.example.com
```

---

## Manual Deployment (Without GitHub Actions)

If you want to run everything locally:

```bash
# 1. Login to Azure
az login
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"

# 2. Initialize and apply Terraform
cd aks/terraform
terraform init \
  -backend-config="resource_group_name=rg-terraform-state" \
  -backend-config="storage_account_name=<STORAGE_ACCOUNT_NAME>" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=aks-ecommerce-dev.tfstate"

terraform plan \
  -var="acr_name=<YOUR_ACR_NAME>" \
  -var="acr_resource_group=<ACR_RG>"

terraform apply \
  -var="acr_name=<YOUR_ACR_NAME>" \
  -var="acr_resource_group=<ACR_RG>"

# 3. Configure kubectl
az aks get-credentials \
  --resource-group rg-aks-ecommerce-dev \
  --name aks-ecommerce-dev \
  --overwrite-existing

# 4. Install NGINX Ingress Controller
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.replicaCount=2 \
  --wait --timeout 5m

# 5. Apply manifests in order
cd ../../
kubectl apply -f aks/k8s/namespace.yaml
kubectl apply -f aks/k8s/configmap.yaml

# Create ACR pull secret
kubectl create secret docker-registry acr-secret \
  --namespace ecommerce \
  --docker-server=<YOUR_ACR_NAME>.azurecr.io \
  --docker-username=<ACR_USERNAME> \
  --docker-password=<ACR_PASSWORD>

# Apply deployments (replace ACR name)
for file in aks/k8s/deployments/*.yaml; do
  sed "s|<YOUR_ACR_NAME>|<YOUR_ACR_NAME>|g" "$file" | kubectl apply -f -
done

kubectl apply -f aks/k8s/services/
kubectl apply -f aks/k8s/ingress/
kubectl apply -f aks/k8s/hpa/

# 6. Verify
kubectl get all -n ecommerce
kubectl get ingress -n ecommerce
kubectl get service ingress-nginx-controller -n ingress-nginx
```

---

## Verify Deployment Health

```bash
# Check all pods are Running
kubectl get pods -n ecommerce

# Check services
kubectl get services -n ecommerce

# Check ingress
kubectl get ingress -n ecommerce

# Check HPA
kubectl get hpa -n ecommerce

# View logs for a service
kubectl logs -l app=api-gateway -n ecommerce --tail=50

# Describe a pod if it's not starting
kubectl describe pod <POD_NAME> -n ecommerce
```

---

## Cleanup

**Delete only the application (keep the cluster):**
1. Run Workflow 2 with action: `delete`

**Delete the entire AKS infrastructure:**
1. Run Workflow 1 with action: `destroy`

Or manually:
```bash
# Destroy Terraform resources
cd aks/terraform
terraform destroy \
  -var="acr_name=<YOUR_ACR_NAME>" \
  -var="acr_resource_group=<ACR_RG>"

# Delete the Terraform state storage (optional)
az group delete --name rg-terraform-state --yes --no-wait
```

> **Warning:** `terraform destroy` will delete the AKS cluster and all resources in the resource group. Your ACR and its images will NOT be deleted (they are in a separate resource group).

---

## Troubleshooting

### ImagePullBackOff
```bash
kubectl describe pod <POD_NAME> -n ecommerce
```
- **Cause 1:** ACR name is wrong. Verify the image name in the pod spec matches your ACR.
- **Cause 2:** `acr-secret` is missing or wrong. Re-run Workflow 2 or recreate the secret manually.
- **Cause 3:** AcrPull role not assigned. Verify in Azure Portal: your ACR → Access Control (IAM) → Role assignments. Look for the AKS kubelet identity.

### Pods in CrashLoopBackOff
```bash
kubectl logs <POD_NAME> -n ecommerce --previous
```
- The application may be failing to start. Check if `/health` endpoint exists on the correct port.
- Verify the correct container port is set in the deployment.

### EXTERNAL-IP stuck at `<pending>`
```bash
kubectl describe service ingress-nginx-controller -n ingress-nginx
```
- Azure Load Balancer provisioning can take 2–5 minutes. Wait and retry.
- Ensure your Azure subscription has not reached the public IP quota.

### Terraform Init Fails (backend error)
- Verify the storage account and container exist: `az storage container list --account-name <NAME>`
- Verify the Service Principal has `Contributor` on the storage account's resource group.
- Verify all 3 backend GitHub Secrets are set correctly.

### Terraform Apply Fails (role assignment error)
```
Error: authorization.RoleAssignmentsClient#Create: ... does not have authorization
```
- The Service Principal needs `User Access Administrator` in addition to `Contributor`.
- Run the role assignment command from Pre-Step 2.

### kubectl: Unauthorized
```bash
az aks get-credentials \
  --resource-group rg-aks-ecommerce-dev \
  --name aks-ecommerce-dev \
  --overwrite-existing
```
- Token may have expired. Re-run the command above to refresh credentials.

### Ingress not routing correctly
```bash
kubectl get ingress -n ecommerce
kubectl describe ingress ecommerce-ingress -n ecommerce
```
- Ensure NGINX Ingress Controller is running: `kubectl get pods -n ingress-nginx`
- Verify `ingressClassName: nginx` is set in `ingress.yaml`

---

## GitHub Secrets Reference

| Secret | Description |
|--------|-------------|
| `AZURE_CLIENT_ID` | Service Principal Client ID |
| `AZURE_CLIENT_SECRET` | Service Principal Client Secret |
| `AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `AZURE_TENANT_ID` | Azure Tenant ID |
| `TF_BACKEND_RESOURCE_GROUP` | Resource group holding Terraform state storage |
| `TF_BACKEND_STORAGE_ACCOUNT` | Storage account name for Terraform state |
| `TF_BACKEND_CONTAINER` | Blob container name (e.g., `tfstate`) |
| `ACR_NAME` | Azure Container Registry name (without `.azurecr.io`) |
| `ACR_RESOURCE_GROUP` | Resource group of the ACR |
| `ACR_USERNAME` | ACR admin username or SP Client ID (for image pull secret) |
| `ACR_PASSWORD` | ACR admin password or SP Client Secret (for image pull secret) |
| `AKS_RESOURCE_GROUP` | Resource group where AKS is deployed (`rg-aks-ecommerce-dev`) |
| `AKS_CLUSTER_NAME` | AKS cluster name (`aks-ecommerce-dev`) |
