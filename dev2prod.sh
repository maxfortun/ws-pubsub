#!/bin/bash -ex

SWD=$(cd $(dirname $0); pwd)

name=$(basename $SWD)
devPodName=$name-dev
prodPodName=$name-prod
containerName=$name

devYaml=$(ls -1 $SWD/k8s/*-deployment-dev.yaml)
prodYaml=$(ls -1 $SWD/k8s/*-deployment-prod.yaml)

devImage=$(yq 'select(.metadata.name == "'$devPodName'")  | .spec.template.spec.containers[] | select(.name == "'$containerName'") |  .image' $devYaml)

prodImage=$(yq 'select(.metadata.name == "'$prodPodName'")  | .spec.template.spec.containers[] | select(.name == "'$containerName'") |  .image' $prodYaml)

docker tag $devImage $prodImage

docker push $prodImage

while read -u 3 node_id; do
	ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -n root@$node_id.$DPSRV_DOMAIN "k3s ctr images ls|awk '{ print \$1 }'|grep '$prodImage\$' | xargs -L1 k3s ctr images rm " &
done 3< <(kubectl get nodes -o json|jq -r '.items[].metadata.name')
wait

kubectl apply -f $prodYaml
kubectl -n dpsrv rollout restart deployment $prodPodName

version=$(yq '.spec.template.spec.containers[].image | capture(".*-(?<ver>[0-9]+\\.[0-9]+\\.[0-9]+)$").ver' $prodYaml)
git commit -a -m "Released $version"
git push
yq -i '.spec.template.spec.containers[].image |= (capture("(?<pre>.*-)(?<maj>[0-9]+)\\.(?<min>[0-9]+)\\.(?<patch>[0-9]+)$") | "\(.pre)\(.maj).\(.min).\((.patch|tonumber + 1))")' $prodYaml

