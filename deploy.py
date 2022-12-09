import json
import os

ret = os.system('git pull')

if ret != 0:
    print('==Failed to pull==')

ret = os.system('npm run build')

if ret != 0:
    print('==Failed to build==')

with open('./package.json', 'r') as p:
    package = json.loads(p.read())

    ret = os.system('npm publish')

    if ret != 0:
        print('==Failed to publish==')

    else:
        ret = os.system(
            f'aws s3 sync ./dist s3://broadwayinc.dev/jslib/skapi/{package["version"]} --acl public-read')

        if ret != 0:
            print('==Failed to upload==')

print('==END==')
