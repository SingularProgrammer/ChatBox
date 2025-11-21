# ChatBox

You can create a chat server on the local network by installing this project on your local computer.

## Setup

After cloning the repository, run this code:

> npm install

This will install the necessary dependencies. Go to the installed folder and create a file named "install.json" next to the index.js file, enter this code in it and fill in the required fields:

```
{
    "Name": "",
    "Description": "",
    "DatabaseSecret": "",
    "Admin": "",
    "AdminPassword": ""
}
```

Then use this command to run the index.js server:

> node index.js