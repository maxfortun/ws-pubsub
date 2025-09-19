#!/bin/bash -ex

SWD=$(dirname $0)

devPodName=ws-pubsub-dev
prodPodName=ws-pubsub-prod
containerName=ws-pubsub

devImage=$(yq 'select(.metadata.name == "'$devPodName'")  | .spec.template.spec.containers[] | select(.name == "'$containerName'") |  .image' $SWD/k8s/04-deployment-dev.yaml)

prodImage=$(yq 'select(.metadata.name == "'$prodPodName'")  | .spec.template.spec.containers[] | select(.name == "'$containerName'") |  .image' $SWD/k8s/05-deployment-prod.yaml)

docker tag $devImage $prodImage

docker push $prodImage

while read -u 3 node_id; do
	ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -n root@$node_id.$DPSRV_DOMAIN "k3s ctr images ls|awk '{ print \$1 }'|grep '$prodImage\$' | xargs -L1 k3s ctr images rm " &
done 3< <(kubectl get nodes -o json|jq -r '.items[].metadata.name')
wait

kubectl -n dpsrv rollout restart deployment $prodPodName
