import json
import os

with open('./package.json','r') as p:
    package = json.loads(p.read())
    os.system('npm publish')