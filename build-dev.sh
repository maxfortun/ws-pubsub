#!/bin/bash -ex

SWD=$(dirname $0)

podName=ws-pubsub-dev
containerName=ws-pubsub

image=$(yq 'select(.metadata.name == "'$podName'")  | .spec.template.spec.containers[] | select(.name == "'$containerName'") |  .image' $SWD/k8s/04-deployment-dev.yaml)
export repo=${image%:*}
export tag=${image##*:}

docker compose build

docker push $image

while read -u 3 node_id; do
	ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -n root@$node_id.$DPSRV_DOMAIN "k3s ctr images ls|awk '{ print \$1 }'|grep '$image\$' | xargs -L1 k3s ctr images rm " &
done 3< <(kubectl get nodes -o json|jq -r '.items[].metadata.name')
wait

kubectl -n dpsrv rollout restart deployment $podName
sleep 2
kubectl -n dpsrv get pods -l app=$podName

