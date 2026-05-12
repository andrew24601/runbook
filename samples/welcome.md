# RunDown Welcome

This workbook exists so the first native RunDown shell has something concrete to open.

```variables name="my_vars"
base_url = "https://jsonplaceholder.typicode.com"
user = "1"
```

The profile request uses the shared base URL and user variables.

```http name="profile"
GET {{my_vars.base_url}}/users/{{my_vars.user}}
Accept: application/json
```

The JSON viewer can bind directly to cached response data.

```json src="profile.body"
```

Once the request runs, markdown can reflect the cached response.

- Profile status: {{profile.status}}
- Profile name: {{profile.body.name}}